import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import type { SoftDeleteModel } from './prisma.soft-delete.middleware';

type SoftDeleteDelegateName = Uncapitalize<SoftDeleteModel>;

/**
 * Generic Prisma query options shape used by soft-delete helpers.
 * The `includeDeleted` field is consumed by this service and stripped
 * before the query reaches the database.
 */
interface QueryOptions {
  where?: Record<string, unknown>;
  /** @deprecated Pass `_includeDeleted: true` inside `where` instead. */
  includeDeleted?: boolean;
  [key: string]: unknown;
}

interface SoftDeleteDelegate {
  delete<T>(args: {
    where: Record<string, unknown>;
    hardDelete?: boolean;
  }): Promise<T>;
  deleteMany(args: {
    where: Record<string, unknown>;
    hardDelete?: boolean;
  }): Promise<{ count: number }>;
  update<T>(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<T>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findUnique<T>(args: QueryOptions): Promise<T | null>;
  findMany<T>(args: QueryOptions): Promise<T[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

/**
 * Service providing utility methods for soft-delete, restore, and purge
 * operations across all soft-deletable models.
 *
 * ## When to use this service
 *
 * | Scenario | Method |
 * |---|---|
 * | Permanent (hard) delete of one record | `hardDelete()` |
 * | Permanent (hard) delete of many records | `hardDeleteMany()` |
 * | Restore a soft-deleted record | `restore()` / `restoreMany()` |
 * | Query including deleted records | `findIncludingDeleted()` / `findManyIncludingDeleted()` |
 * | Query only deleted records | `findManyDeleted()` |
 * | Count deleted records | `countDeleted()` |
 * | Retention-based cleanup | `permanentlyDeleteExpired()` |
 * | Check if a record is deleted | `isDeleted()` |
 *
 * Normal application code (outside GDPR/admin/retention flows) should use
 * repository methods (`SoftDeleteRepository`) and rely on the middleware to
 * transparently soft-delete records.
 *
 * ## Audit trail
 *
 * Every hard-delete (purge) operation writes a best-effort `AuditLog` entry
 * with `action: AuditAction.DELETE`.  A failed audit write is logged as an
 * error but does NOT fail the purge — the purge has already committed.
 *
 * See also: SOFT_DELETE_GUIDE.md §6, §8, §9
 */
@Injectable()
export class SoftDeleteService {
  private readonly logger = new Logger(SoftDeleteService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Purge (hard delete) ─────────────────────────────────────────────────────

  /**
   * Permanently delete a single record from the database (hard delete).
   *
   * ⚠️ This is irreversible.  Use only for:
   *   - GDPR right-to-erasure
   *   - Approved admin / retention flows
   *
   * Always supply a `reason` — it is written to the `AuditLog` and is
   * critical for incident response.
   *
   * Internally passes `hardDelete: true` to the soft-delete middleware so
   * the operation is forwarded as a real SQL DELETE rather than being
   * converted to a soft-delete UPDATE.
   */
  async hardDelete<T>(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
    reason?: string,
  ): Promise<T | null> {
    this.logger.warn(
      `Hard deleting ${model as string} with where: ${JSON.stringify(where)}. Reason: ${reason ?? 'Not provided'}`,
    );

    // `hardDelete: true` opts out of the middleware's delete → soft-delete
    // conversion.  Without it this call would silently become a soft delete.
    const result = await this.getDelegate(model).delete<T>({
      where,
      hardDelete: true,
    });

    await this.recordPurgeAudit(model, where, reason);

    return result;
  }

  /**
   * Permanently delete multiple records from the database (hard delete).
   *
   * ⚠️ This is irreversible.  Always supply a `reason`.
   */
  async hardDeleteMany(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
    reason?: string,
  ): Promise<{ count: number }> {
    this.logger.warn(
      `Hard deleting ${model as string} records with where: ${JSON.stringify(where)}. Reason: ${reason ?? 'Not provided'}`,
    );

    const result = await this.getDelegate(model).deleteMany({
      where,
      hardDelete: true,
    });

    await this.recordPurgeAudit(model, where, reason, result.count);

    return result;
  }

  // ── Restore ─────────────────────────────────────────────────────────────────

  /**
   * Restore a single soft-deleted record by clearing `deletedAt`.
   *
   * The underlying `update` call sets `data.deletedAt = null`, which the
   * middleware recognises as a restore and skips the `deletedAt IS NULL`
   * filter on `where` — allowing the deleted row to be reached.
   */
  async restore<T>(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
  ): Promise<T> {
    this.logger.log(
      `Restoring ${model as string} record: ${JSON.stringify(where)}`,
    );

    return this.getDelegate(model).update<T>({
      where,
      // data.deletedAt === null signals the middleware that this is a
      // restore, causing it to bypass the deletedAt: null filter on `where`.
      data: { deletedAt: null },
    });
  }

  /**
   * Restore multiple soft-deleted records by clearing `deletedAt`.
   *
   * Uses `updateMany` which also triggers the middleware restore path when
   * `data.deletedAt === null`.
   */
  async restoreMany(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
  ): Promise<{ count: number }> {
    this.logger.log(
      `Restoring multiple ${model as string} records: ${JSON.stringify(where)}`,
    );

    return this.getDelegate(model).updateMany({
      where,
      data: { deletedAt: null },
    });
  }

  // ── Queries including / targeting deleted records ──────────────────────────

  /**
   * Find a single record regardless of its `deletedAt` status.
   *
   * Injects `_includeDeleted: true` into `where`, which the middleware
   * recognises and strips before the query reaches the database.
   */
  async findIncludingDeleted<T>(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
  ): Promise<T | null> {
    return this.getDelegate(model).findUnique<T>({
      where: {
        ...where,
        _includeDeleted: true,
      },
    });
  }

  /**
   * Find multiple records regardless of their `deletedAt` status.
   *
   * Always injects `_includeDeleted: true` into `where` so the middleware
   * skips the default `deletedAt IS NULL` filter.  Any `includeDeleted`
   * property on `options` is accepted for backwards compatibility but is
   * redundant — this method always includes deleted records.
   */
  async findManyIncludingDeleted<T>(
    model: SoftDeleteDelegateName,
    options: QueryOptions = {},
  ): Promise<T[]> {
    // Always inject _includeDeleted regardless of whether options.includeDeleted
    // was set.  This is the authoritative "include deleted" query path —
    // callers should not need to think about the flag.
    const { includeDeleted: _unused, ...restOptions } = options;
    void _unused; // consumed; not forwarded to Prisma

    return this.getDelegate(model).findMany<T>({
      ...restOptions,
      where: {
        ...restOptions.where,
        _includeDeleted: true,
      },
    });
  }

  /**
   * Find records that have been soft-deleted (`deletedAt IS NOT NULL`).
   *
   * This is the primary method for admin/audit views that need to enumerate
   * what has been deleted without including live records.
   */
  async findManyDeleted<T>(
    model: SoftDeleteDelegateName,
    options: QueryOptions = {},
  ): Promise<T[]> {
    return this.getDelegate(model).findMany<T>({
      ...options,
      where: {
        ...options.where,
        deletedAt: { not: null },
      },
    });
  }

  /**
   * Count soft-deleted records matching the given `where` clause.
   *
   * Useful for admin dashboards and retention reporting.
   */
  async countDeleted(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown> = {},
  ): Promise<number> {
    return this.getDelegate(model).count({
      where: {
        ...where,
        deletedAt: { not: null },
      },
    });
  }

  // ── Retention cleanup ───────────────────────────────────────────────────────

  /**
   * Permanently delete soft-deleted records older than `deletedBefore`.
   *
   * This is the canonical retention-cleanup path.  It:
   *   1. Issues a `deleteMany` with `hardDelete: true` (bypasses middleware
   *      conversion so rows are truly removed from the database).
   *   2. Writes a best-effort `AuditLog` entry with the cleanup reason.
   *
   * Schedule this via a NestJS `@Cron()` job or an admin endpoint protected
   * by appropriate role guards.
   *
   * @param model         - The model to purge (e.g. `'refreshToken'`)
   * @param deletedBefore - Only purge rows soft-deleted before this date
   * @returns             - Number of rows permanently deleted
   */
  async permanentlyDeleteExpired(
    model: SoftDeleteDelegateName,
    deletedBefore: Date,
  ): Promise<number> {
    this.logger.log(
      `Permanently deleting ${model as string} records soft-deleted before ${deletedBefore.toISOString()}`,
    );

    const where = {
      deletedAt: {
        not: null,
        lt: deletedBefore,
      },
    };

    const result = await this.getDelegate(model).deleteMany({
      where,
      hardDelete: true,
    });

    await this.recordPurgeAudit(
      model,
      where,
      `Retention cleanup — soft-deleted before ${deletedBefore.toISOString()}`,
      result.count,
    );

    return result.count;
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  /**
   * Returns `true` if the record exists in the database and has been
   * soft-deleted (`deletedAt IS NOT NULL`).
   *
   * Returns `false` if the record does not exist or is still live.
   */
  async isDeleted(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
  ): Promise<boolean> {
    const record = await this.getDelegate(model).findUnique<{
      deletedAt?: Date | null;
    }>({
      where: {
        ...where,
        _includeDeleted: true,
      },
    });

    return record?.deletedAt !== null && record?.deletedAt !== undefined;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private getDelegate(model: SoftDeleteDelegateName): SoftDeleteDelegate {
    return this.prisma[model] as unknown as SoftDeleteDelegate;
  }

  /**
   * Write an `AuditLog` entry for a permanent (hard) deletion.
   *
   * Best-effort: a failure here is logged as an error but does NOT roll back
   * or fail the purge.  The purge has already been committed by the time this
   * runs.
   */
  private async recordPurgeAudit(
    model: SoftDeleteDelegateName,
    where: Record<string, unknown>,
    reason?: string,
    count?: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: AuditAction.DELETE,
          entityType: model as string,
          entityId: typeof where.id === 'string' ? where.id : 'bulk',
          beforeState: JSON.parse(
            JSON.stringify({ where, ...(count !== undefined && { count }) }),
          ) as Prisma.InputJsonValue,
          reason: reason ?? 'Hard delete (no reason provided)',
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for hard delete of ${model as string}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
