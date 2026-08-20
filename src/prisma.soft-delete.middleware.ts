import { Prisma } from '@prisma/client';

/**
 * Models that support soft delete (have deletedAt field).
 *
 * Rules:
 *  1. Every model listed here MUST have a `deletedAt DateTime?` column and an
 *     `@@index([deletedAt])` in prisma/schema.prisma.
 *  2. No model should be added to this list without also adding the migration.
 *  3. To *bypass* soft-delete for a new model (e.g. an immutable event ledger),
 *     leave it absent from this list and document the reason in SOFT_DELETE_GUIDE.md.
 *
 * See also: SOFT_DELETE_GUIDE.md §2
 */
export const SOFT_DELETE_MODELS = [
  'User',
  'Project',
  'Contribution',
  'Milestone',
  'ReputationHistory',
  'Category',
  'InsurancePool',
  'ReinsuranceContract',
  'InsurancePolicy',
  'Claim',
  'AuditLog',
  'LedgerCursor',
  'ProcessedEvent',
  'QuarantinedEvent',
  'IndexerLog',
  'NotificationSetting',
  'Notification',
  'EmailOutbox',
  'IdempotencyKey',
  'RefreshToken',
] as const;

export type SoftDeleteModel = (typeof SOFT_DELETE_MODELS)[number];

/**
 * Configuration for soft delete behavior.
 */
export interface SoftDeleteConfig {
  /**
   * Whether to exclude soft-deleted records by default.
   * Can be overridden per-query with the `_includeDeleted` flag inside `where`
   * or the `includeDeleted` top-level query argument.
   *
   * Should always be `true` in production.  Pass `false` only in unit tests
   * that need to assert on raw DB state.
   */
  excludeDeleted?: boolean;
}

type MiddlewareNext = (params: Prisma.MiddlewareParams) => Promise<unknown>;

type SoftDeleteWhere = Record<string, unknown> & {
  /**
   * Non-standard Prisma flag consumed by this middleware.
   * When `true` inside `where`, the `deletedAt IS NULL` filter is suppressed
   * and the flag is removed before the query reaches the database.
   *
   * Prefer `SoftDeleteService.findIncludingDeleted()` over using this flag
   * directly in application code.
   */
  _includeDeleted?: boolean;
  /**
   * Non-standard Prisma flag consumed by this middleware.
   * When `true` inside `where` on a delete/deleteMany, the middleware does NOT
   * convert the operation to a soft-delete UPDATE — the real SQL DELETE is
   * forwarded to the database.
   *
   * Only `SoftDeleteService.hardDelete()` / `hardDeleteMany()` should set this
   * flag.  Any other caller must justify the bypass with a comment.
   */
  _hardDelete?: boolean;
};

interface SoftDeleteMiddlewareArgs {
  where?: SoftDeleteWhere;
  /** Top-level alternative to `where._includeDeleted`. */
  includeDeleted?: boolean;
  /** Top-level alternative to `where._hardDelete`. */
  hardDelete?: boolean;
  data?: Record<string, unknown>;
}

/**
 * Create the global soft-delete Prisma middleware.
 *
 * Register this **once** in `PrismaService.onModuleInit()`:
 *
 * ```typescript
 * this.$use(createSoftDeleteMiddleware({ excludeDeleted: true }));
 * ```
 *
 * ## What this middleware does
 *
 * ### Read actions (findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow,
 *                   findMany, count, aggregate, groupBy)
 *   - Injects `deletedAt: null` into `where` unless the caller passes
 *     `_includeDeleted: true` (in `where`) or `includeDeleted: true`
 *     (top-level).
 *   - Removes the non-standard flags before forwarding to the database.
 *
 * ### Write actions — soft delete (delete, deleteMany)
 *   - Converts to `update` / `updateMany` that stamps `deletedAt = NOW()`.
 *   - Only rows where `deletedAt IS NULL` are touched (idempotent).
 *   - Opt-out: pass `hardDelete: true` (top-level) or `_hardDelete: true`
 *     (inside `where`) to bypass the conversion and issue a real SQL DELETE.
 *
 * ### Write actions — update / updateMany
 *   - Injects `deletedAt: null` into `where` so updates cannot accidentally
 *     touch soft-deleted rows.
 *   - Restore exception: when `data.deletedAt === null` the filter is skipped
 *     so soft-deleted rows can be recovered.
 *
 * ### Upsert
 *   - Injects `deletedAt: null` into the `create` branch (new rows start live).
 *   - Injects `deletedAt: null` into the `update` branch (prevents accidental
 *     re-stamping of deletedAt via an incomplete payload).
 *   - Callers that set `deletedAt` explicitly in either branch take precedence.
 *
 * See SOFT_DELETE_GUIDE.md for the full lifecycle and query conventions.
 */
export function createSoftDeleteMiddleware(
  config: SoftDeleteConfig = { excludeDeleted: true },
) {
  return async (params: Prisma.MiddlewareParams, next: MiddlewareNext) => {
    const { model, action } = params;
    const args = getMiddlewareArgs(params);

    // Only apply to models that support soft delete.
    if (!SOFT_DELETE_MODELS.includes(model as SoftDeleteModel)) {
      return next(params);
    }

    // ── Read actions ──────────────────────────────────────────────────────────
    //
    // Covers: findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow,
    //         findMany, count, aggregate, groupBy
    //
    // groupBy and aggregate use a top-level `where` just like findMany, so
    // the same injection logic applies without any special-casing.
    if (
      [
        'findUnique',
        'findUniqueOrThrow',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'count',
        'aggregate',
        'groupBy',
      ].includes(action)
    ) {
      const includeDeleted = shouldIncludeDeleted(args);

      if (config.excludeDeleted && !includeDeleted) {
        args.where = {
          ...args.where,
          deletedAt: null,
        };
      }

      // Remove our non-standard flags before the query reaches the database.
      removeIncludeDeletedFlags(args);

      return next(params);
    }

    // ── Update / UpdateMany ───────────────────────────────────────────────────
    //
    // Prevent updates from silently touching soft-deleted rows.
    // Exception: restore operations set `data.deletedAt === null` and must
    // be able to reach deleted rows — the filter is intentionally skipped
    // for them.
    if (action === 'update' || action === 'updateMany') {
      // A restore is the only legitimate reason to update a deleted row.
      // Detect it by checking for an explicit `null` (not undefined) on
      // deletedAt in the data payload.
      const isRestore = args.data?.deletedAt === null;

      if (config.excludeDeleted && !isRestore) {
        args.where = {
          ...args.where,
          deletedAt: null,
        };
      }

      return next(params);
    }

    // ── Delete / DeleteMany ───────────────────────────────────────────────────
    //
    // Default: convert to a soft-delete UPDATE.
    // Opt-out: `hardDelete: true` (top-level) or `where._hardDelete: true`
    //          forwards the real SQL DELETE — used exclusively by
    //          SoftDeleteService.hardDelete() / hardDeleteMany() and by
    //          approved GDPR/admin paths.
    if (action === 'delete' || action === 'deleteMany') {
      if (shouldHardDelete(args)) {
        // Strip the flag before forwarding so Prisma doesn't see it.
        removeHardDeleteFlags(args);
        return next(params);
      }

      removeHardDeleteFlags(args);

      // Convert delete → soft-delete UPDATE.
      // Only rows that are NOT already soft-deleted are touched, making
      // repeated calls idempotent.
      const softDeleteArgs = {
        where: {
          ...args.where,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
        },
      };

      return next({
        ...params,
        action: action === 'delete' ? 'update' : 'updateMany',
        args: softDeleteArgs,
      });
    }

    // ── Upsert ────────────────────────────────────────────────────────────────
    //
    // Guard new rows created via upsert so they always start as live
    // (deletedAt: null), and prevent an incomplete `update` payload from
    // accidentally clearing or setting deletedAt.
    //
    // Callers that explicitly provide `deletedAt` in their payload take
    // precedence — the injected defaults are only applied when the field is
    // absent.
    if (action === 'upsert') {
      const upsertArgs = args as unknown as {
        where?: Record<string, unknown>;
        create?: Record<string, unknown>;
        update?: Record<string, unknown>;
      };

      // New rows created by the upsert must start as live.
      if (upsertArgs.create && !('deletedAt' in upsertArgs.create)) {
        upsertArgs.create = {
          ...upsertArgs.create,
          deletedAt: null,
        };
      }

      // Existing rows matched by the upsert must not have deletedAt touched
      // unless the caller explicitly provides a value.
      if (upsertArgs.update && !('deletedAt' in upsertArgs.update)) {
        upsertArgs.update = {
          ...upsertArgs.update,
          deletedAt: null,
        };
      }

      return next(params);
    }

    return next(params);
  };
}

// ── Private helpers ────────────────────────────────────────────────────────────

function getMiddlewareArgs(
  params: Prisma.MiddlewareParams,
): SoftDeleteMiddlewareArgs {
  if (!params.args) {
    params.args = {};
  }
  return params.args as SoftDeleteMiddlewareArgs;
}

/**
 * Returns true if the caller opted into seeing soft-deleted rows.
 * Checks both the `where._includeDeleted` shorthand and the top-level
 * `includeDeleted` flag for backwards compatibility.
 */
function shouldIncludeDeleted(args: SoftDeleteMiddlewareArgs): boolean {
  return args.where?._includeDeleted === true || args.includeDeleted === true;
}

/**
 * Returns true if the caller explicitly requested a hard (permanent) delete.
 * Checks both the `where._hardDelete` shorthand and the top-level `hardDelete`
 * flag.
 *
 * Only `SoftDeleteService` and approved GDPR/admin paths should trigger this.
 */
function shouldHardDelete(args: SoftDeleteMiddlewareArgs): boolean {
  return args.where?._hardDelete === true || args.hardDelete === true;
}

function removeHardDeleteFlags(args: SoftDeleteMiddlewareArgs): void {
  if (args.where?._hardDelete !== undefined) {
    delete args.where._hardDelete;
  }
  if (args.hardDelete !== undefined) {
    delete args.hardDelete;
  }
}

function removeIncludeDeletedFlags(args: SoftDeleteMiddlewareArgs): void {
  if (args.where?._includeDeleted !== undefined) {
    delete args.where._includeDeleted;
  }
  if (args.includeDeleted !== undefined) {
    delete args.includeDeleted;
  }
}
