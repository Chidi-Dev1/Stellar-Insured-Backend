# Soft-Delete & Record Lifecycle Guide

This document is the authoritative reference for how soft-delete works in the
Stellar Insured backend. All contributors should read it before touching deletion,
restore, or purge logic.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Models that support soft-delete](#2-models-that-support-soft-delete)
3. [How the middleware works](#3-how-the-middleware-works)
4. [Query conventions](#4-query-conventions)
5. [Repository layer](#5-repository-layer)
6. [SoftDeleteService (admin / purge operations)](#6-softdeleteservice-admin--purge-operations)
7. [Lifecycle state machine](#7-lifecycle-state-machine)
8. [Audit and admin flows](#8-audit-and-admin-flows)
9. [Hard-delete (purge) policy](#9-hard-delete-purge-policy)
10. [Adding a new model](#10-adding-a-new-model)
11. [Common mistakes](#11-common-mistakes)

---

## 1. Overview

Soft-delete is the default deletion mechanism for **all** tracked models.
Deleting a record sets `deletedAt` to the current timestamp instead of issuing
a SQL `DELETE`.  The Prisma middleware (`createSoftDeleteMiddleware`) enforces
this transparently for every affected model.

Key properties:

| Property | Value |
|---|---|
| Default filter | `WHERE deleted_at IS NULL` on every read |
| Deletion mechanism | `UPDATE … SET deleted_at = NOW()` |
| Hard delete | Opt-in via `hardDelete: true` flag or `SoftDeleteService` |
| Restore | `UPDATE … SET deleted_at = NULL` via `SoftDeleteRepository.restore()` |
| Purge | `SoftDeleteService.permanentlyDeleteExpired()` or `hardDelete()` |

---

## 2. Models that support soft-delete

The following 20 models all have a `deletedAt DateTime?` field and an
`@@index([deletedAt])` index.  They are enumerated in
`SOFT_DELETE_MODELS` inside
[`src/prisma.soft-delete.middleware.ts`](src/prisma.soft-delete.middleware.ts).

| Model | Table | Notes |
|---|---|---|
| `User` | `users` | PII — purge only via GDPR erasure flow |
| `Project` | `projects` | Legacy indexer model |
| `Contribution` | `contributions` | Legacy indexer model |
| `Milestone` | `milestones` | Legacy indexer model |
| `ReputationHistory` | `reputation_history` | Append-only; restore may affect score |
| `Category` | `categories` | Reference data; prefer deactivation |
| `InsurancePool` | `insurance_pools` | Primary domain |
| `ReinsuranceContract` | `reinsurance_contracts` | Primary domain |
| `InsurancePolicy` | `insurance_policies` | Primary domain |
| `Claim` | `claims` | Primary domain |
| `AuditLog` | `audit_logs` | Immutable; soft-delete only for archival |
| `LedgerCursor` | `ledger_cursors` | Indexer |
| `ProcessedEvent` | `processed_events` | Indexer — deduplicated by `eventId` |
| `QuarantinedEvent` | `quarantined_events` | Indexer |
| `IndexerLog` | `indexer_logs` | Indexer |
| `NotificationSetting` | `notification_settings` | One row per user |
| `Notification` | `notifications` | Consumer-facing |
| `EmailOutbox` | `email_outbox` | Transient; purge after delivery |
| `IdempotencyKey` | `idempotency_keys` | Purge after `expiresAt` |
| `RefreshToken` | `refresh_tokens` | Purge on rotation / expiry |

**No model intentionally bypasses soft-delete.** If a model should truly skip
the middleware (e.g. a future immutable event log), it must be explicitly
*excluded* from `SOFT_DELETE_MODELS` and that decision documented here.

---

## 3. How the middleware works

`createSoftDeleteMiddleware` is registered **once** in
`PrismaService.onModuleInit()` with `{ excludeDeleted: true }`.
It intercepts the following Prisma actions:

### 3.1 Read actions

`findUnique` · `findUniqueOrThrow` · `findFirst` · `findFirstOrThrow` ·
`findMany` · `count` · `aggregate` · `groupBy`

Behaviour: injects `deletedAt: null` into the `where` clause unless the caller
opts in with `_includeDeleted: true` (inside `where`) or `includeDeleted: true`
(top-level query argument).

```typescript
// Default — excludes soft-deleted rows
await prisma.insurancePolicy.findMany({ where: { userId } });

// Opt-in — returns soft-deleted rows too
await prisma.insurancePolicy.findMany({
  where: { userId, _includeDeleted: true },
});

// Alternative top-level flag (also works)
await prisma.insurancePolicy.findMany({
  where: { userId },
  includeDeleted: true,   // non-standard; cleaned up before reaching DB
});
```

### 3.2 Write actions — soft delete

`delete` · `deleteMany`

Behaviour: converted to `update` / `updateMany` that stamps `deletedAt`.
Only rows where `deletedAt IS NULL` are affected (idempotent — a second
delete is a no-op on already-deleted rows).

```typescript
// Caller writes a normal delete …
await prisma.claim.delete({ where: { id } });

// … middleware converts it to:
// UPDATE claims SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL
```

To issue a real SQL `DELETE`, pass the `hardDelete` opt-out (see §4.3).

### 3.3 Write actions — update / updateMany

`update` · `updateMany`

Behaviour: injects `deletedAt: null` into `where` so updates cannot
accidentally touch soft-deleted rows.

**Restore exception**: when `data.deletedAt === null` the middleware detects
a restore operation and skips the filter so the deleted row can be reached.

```typescript
// Normal update — only touches live rows
await prisma.insurancePolicy.update({ where: { id }, data: { status: 'ACTIVE' } });

// Restore — middleware skips deletedAt filter
await prisma.claim.update({ where: { id }, data: { deletedAt: null } });
```

### 3.4 Upsert

`upsert`

Behaviour:

- `create` branch: `deletedAt: null` is injected if absent (new rows start
  as live).
- `update` branch: `deletedAt: null` is injected if absent (prevents an
  accidentally-undefined payload from soft-deleting the row).

Callers that intentionally set `deletedAt` in either branch take precedence.

---

## 4. Query conventions

### 4.1 Standard read (default)

Always excludes soft-deleted records. No extra flags needed.

```typescript
const policy = await this.policyRepository.findById(id);
```

### 4.2 Include deleted records

Pass `_includeDeleted: true` inside `where`:

```typescript
const allPolicies = await prisma.insurancePolicy.findMany({
  where: { userId, _includeDeleted: true },
});
```

Or use `SoftDeleteService.findIncludingDeleted()` / `findManyIncludingDeleted()`.

### 4.3 Hard-delete (purge)

**Never call this outside of `SoftDeleteService` or an explicitly-approved
GDPR/admin path.** Pass `hardDelete: true`:

```typescript
// Direct (avoid unless you have a specific reason):
await prisma.refreshToken.delete({ where: { id }, hardDelete: true });

// Preferred — goes through SoftDeleteService for audit logging:
await this.softDeleteService.hardDelete('refreshToken', { id }, 'Token rotation');
```

### 4.4 Restore

Use `SoftDeleteRepository.restore()` or `SoftDeleteService.restore()`:

```typescript
// Repository layer (single record by ID)
await this.claimRepository.restore(claimId);

// Service layer (arbitrary where clause, with audit log)
await this.softDeleteService.restore('claim', { id: claimId });
```

### 4.5 groupBy and aggregate over deleted data

```typescript
// Excludes deleted rows by default
await prisma.claim.groupBy({ by: ['status'], _count: true });

// Include deleted
await prisma.claim.groupBy({
  by: ['status'],
  where: { _includeDeleted: true },
  _count: true,
});
```

---

## 5. Repository layer

### 5.1 Class hierarchy

```
BaseRepository<T, ID>
  └─ SoftDeleteRepository<T, ID>
       ├─ ClaimRepository
       ├─ InsurancePolicyRepository
       ├─ InsurancePoolRepository
       ├─ ReinsuranceContractRepository
       ├─ UserRepository
       ├─ ProjectRepository
       └─ … (all other model repositories)
```

### 5.2 `BaseRepository.delete(id)`

Calls `prisma[model].delete({ where: { id } })`.  The soft-delete middleware
converts this to a soft-delete automatically.

> **Note**: The method is named `delete` but it performs a **soft-delete**.
> This is intentional — callers should treat `delete` as the standard, safe
> removal path. If you need a hard delete, use `SoftDeleteService.hardDelete()`.

### 5.3 `SoftDeleteRepository` extras

| Method | What it does |
|---|---|
| `softDelete(id)` | Stamps `deletedAt` explicitly via `update`. Equivalent to `delete()` but bypasses middleware conversion (useful when you need to control the timestamp). |
| `restore(id)` | Clears `deletedAt` via `updateMany({ where: { id, deletedAt: { not: null } } })`. `updateMany` triggers the middleware's restore path because `data.deletedAt === null`. |
| `softDeleteMany(where)` | Stamps `deletedAt` on all matching rows. |

### 5.4 Transaction support

Every repository method accepts an optional `tx?: TransactionClient` so it
can participate in a `prisma.$transaction()` block without losing middleware
coverage (the transaction client inherits the same middleware stack).

```typescript
await this.prisma.$transaction(async tx => {
  await this.policyRepository.updateStatus(id, PolicyStatus.CANCELLED, tx);
  await this.poolService.unlockCapital(poolId, amount, tx);
});
```

---

## 6. SoftDeleteService (admin / purge operations)

`SoftDeleteService` is the **only** place where hard-delete (purge) logic
should live outside of explicitly-approved admin controllers.

| Method | Purpose |
|---|---|
| `hardDelete(model, where, reason)` | Permanently deletes one record; writes an audit log entry. |
| `hardDeleteMany(model, where, reason)` | Permanently deletes matching records; writes audit log. |
| `restore(model, where)` | Restores a soft-deleted record. |
| `restoreMany(model, where)` | Restores multiple soft-deleted records. |
| `findIncludingDeleted(model, where)` | Returns a single record regardless of `deletedAt`. |
| `findManyIncludingDeleted(model, options)` | Returns all matching records regardless of `deletedAt`. |
| `findManyDeleted(model, options)` | Returns only soft-deleted records (`deletedAt IS NOT NULL`). |
| `countDeleted(model, where)` | Counts soft-deleted records. |
| `permanentlyDeleteExpired(model, deletedBefore)` | Purges records soft-deleted before a given date (retention cleanup). |
| `isDeleted(model, where)` | Returns `true` if the record exists and is soft-deleted. |

All purge operations write a best-effort `AuditLog` entry with
`action: AuditAction.DELETE` and the `reason` you supply.

---

## 7. Lifecycle state machine

```
                    ┌─────────────────────────────────────────┐
                    │           LIVE (deletedAt IS NULL)       │
                    │                                          │
                    │  create()  ──────────────────────────►  │
                    │                                          │
                    │  update() / updateMany()  (status etc.)  │
                    │                                          │
                    └───────────────┬──────────────────────────┘
                                    │ delete() / deleteMany()
                                    │ (middleware converts to UPDATE)
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │     SOFT-DELETED (deletedAt IS NOT NULL)  │
                    │                                          │
                    │  invisible to all standard queries       │
                    │  visible via _includeDeleted flag        │
                    │  visible via SoftDeleteService helpers   │
                    │                                          │
                    └──────┬────────────────────┬─────────────┘
                           │ restore()           │ hardDelete() /
                           │                     │ permanentlyDeleteExpired()
                           ▼                     ▼
                    ┌──────────────┐   ┌─────────────────────┐
                    │     LIVE     │   │  PURGED (gone from  │
                    │  (restored)  │   │    the database)    │
                    └──────────────┘   └─────────────────────┘
```

**Distinguishing soft-deleted from purged records**:

- Soft-deleted records exist in the database with `deletedAt IS NOT NULL`.
  They appear in audit logs and can be restored.
- Purged records no longer exist in any table. Their last trace is an
  `AuditLog` row with `action = 'DELETE'` and `beforeState` containing a
  snapshot of the `where` clause used for the purge.

---

## 8. Audit and admin flows

### 8.1 Viewing soft-deleted records

Any admin query that passes `_includeDeleted: true` in `where` will see all
records, both live and soft-deleted.

```typescript
// Admin endpoint: list all deleted policies for a user
const deleted = await this.softDeleteService.findManyDeleted(
  'insurancePolicy',
  { where: { userId } },
);
```

### 8.2 Identifying the deletion event

Every soft-delete operation goes through the middleware's `update` path.
If you need to know *who* deleted a record and *when*, query `AuditLog`:

```typescript
const auditEntry = await prisma.auditLog.findFirst({
  where: {
    entityType: 'InsurancePolicy',
    entityId: policyId,
    action: AuditAction.DELETE,
  },
  orderBy: { timestamp: 'desc' },
});
```

> **Note**: The domain services (`InsuranceService`, `ClaimService`) call
> `AuditService` explicitly for business-level events (purchase, approve,
> reject, payout). For soft-deletes triggered directly through the repository
> layer, an `AuditLog` entry is only created automatically for **hard-delete
> (purge)** operations via `SoftDeleteService`.  If you need an audit trail
> for soft-deletes too, call `AuditService.logUpdate()` or
> `AuditService.log()` in the same transaction.

### 8.3 Identifying purged records

Purged records leave an `AuditLog` entry with `action = 'DELETE'` and the
`beforeState` field containing `{ where: …, count?: … }`.  Because
`AuditLog` itself is soft-deletable, purge entries are never removed by
default.

---

## 9. Hard-delete (purge) policy

Hard deletes must only be used for:

| Scenario | Approved path |
|---|---|
| GDPR right-to-erasure | `SoftDeleteService.hardDelete('user', { id }, 'GDPR erasure request #…')` |
| Token rotation (refresh tokens) | `SoftDeleteService.hardDeleteMany('refreshToken', { familyId, expiresAt: { lt: now } }, 'Rotation cleanup')` |
| Retention cleanup (configurable TTL) | `SoftDeleteService.permanentlyDeleteExpired(model, cutoffDate)` |
| Re-org rollback (indexer) | Approved migration script only |
| Idempotency key expiry | `SoftDeleteService.permanentlyDeleteExpired('idempotencyKey', cutoffDate)` |

Every other deletion must be a soft-delete.

---

## 10. Adding a new model

1. Add `deletedAt DateTime? @map("deleted_at")` to the model in
   `prisma/schema.prisma`.
2. Add `@@index([deletedAt])` to the model.
3. Add the model name to `SOFT_DELETE_MODELS` in
   `src/prisma.soft-delete.middleware.ts`.
4. Run `npx prisma migrate dev --name add_soft_delete_to_<model>`.
5. Update the model table in §2 of this document.

If a new model intentionally *bypasses* soft-delete (immutable ledger rows,
pure event log, etc.), document it in §2 with a clear reason and ensure it is
absent from `SOFT_DELETE_MODELS`.

---

## 11. Common mistakes

### ❌ Calling `prisma[model].delete()` and expecting a hard delete

```typescript
// WRONG — this is intercepted by middleware and becomes a soft-delete
await prisma.claim.delete({ where: { id } });
```

Use `SoftDeleteService.hardDelete()` when you need a real SQL `DELETE`.

### ❌ Calling `prisma[model].update()` on a soft-deleted record

Standard updates inject `deletedAt: null` into `where`, so they silently
no-op on soft-deleted rows.

```typescript
// WRONG — will silently do nothing if the claim is soft-deleted
await prisma.claim.update({ where: { id }, data: { status: 'APPROVED' } });
```

Restore the record first, then update it; or use `SoftDeleteService.restore()`.

### ❌ Forgetting `_includeDeleted` in admin queries

Admin or analytics queries that forget the flag will silently omit deleted
rows, producing misleading counts/reports.

### ❌ Adding `deletedAt` to a model without updating `SOFT_DELETE_MODELS`

The middleware only intercepts models listed in `SOFT_DELETE_MODELS`.  A
model with a `deletedAt` column but absent from the list will receive real
SQL `DELETE` operations.

### ❌ Doing a hard-delete without a reason string

All `SoftDeleteService` purge methods accept a `reason` argument.  Always
supply one — it is written into the `AuditLog.reason` field and is
invaluable during incident response.
