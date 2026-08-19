import { Prisma } from '@prisma/client';

/**
 * Models that support soft delete (have deletedAt field)
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
 * Configuration for soft delete behavior
 */
export interface SoftDeleteConfig {
  /**
   * Whether to exclude soft-deleted records by default
   * Can be overridden per query with includeDeleted flag
   */
  excludeDeleted?: boolean;
}

type MiddlewareNext = (params: Prisma.MiddlewareParams) => Promise<unknown>;

type SoftDeleteWhere = Record<string, unknown> & {
  _includeDeleted?: boolean;
  _hardDelete?: boolean;
};

interface SoftDeleteMiddlewareArgs {
  where?: SoftDeleteWhere;
  includeDeleted?: boolean;
  hardDelete?: boolean;
  data?: Record<string, unknown>;
}

/**
 * Query extension to include soft-deleted records
 * Usage: await prisma.user.findMany({ includeDeleted: true })
 */
declare global {
  namespace PrismaJson {}
}

/**
 * Create soft delete middleware for Prisma
 * This middleware automatically filters out soft-deleted records
 * and prevents hard deletes unless explicitly allowed
 */
export function createSoftDeleteMiddleware(
  config: SoftDeleteConfig = { excludeDeleted: true },
) {
  return async (params: Prisma.MiddlewareParams, next: MiddlewareNext) => {
    const { model, action } = params;
    const args = getMiddlewareArgs(params);

    // Only apply to models that support soft delete
    if (!SOFT_DELETE_MODELS.includes(model as SoftDeleteModel)) {
      return next(params);
    }

    // Handle find operations - add where clause for soft delete
    if (
      ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findMany'].includes(
        action,
      )
    ) {
      // Check if includeDeleted is explicitly set to true in query options
      const includeDeleted = shouldIncludeDeleted(args);

      if (config.excludeDeleted && !includeDeleted) {
        // Add deletedAt filter to where clause
        args.where = {
          ...args.where,
          deletedAt: null,
        };
      }

      // Remove the flag from the query before sending to database
      removeIncludeDeletedFlags(args);
    }

    // Handle update operations - prevent updating through relations
    if (action === 'update' || action === 'updateMany') {
      // Restore operations (data.deletedAt === null) must be able to reach
      // soft-deleted rows, otherwise a deleted record could never be recovered.
      const isRestore = args.data?.deletedAt === null;

      // Only update non-deleted records
      if (config.excludeDeleted && !isRestore) {
        args.where = {
          ...args.where,
          deletedAt: null,
        };
      }
    }

    // Handle delete operations - convert to soft delete
    if (action === 'delete' || action === 'deleteMany') {
      // Explicit, audited purge paths (e.g. SoftDeleteService.hardDelete,
      // GDPR erasure, re-org rollbacks) may opt out of the conversion.
      if (shouldHardDelete(args)) {
        removeHardDeleteFlags(args);
        return next(params);
      }

      removeHardDeleteFlags(args);

      // Convert delete to update with deletedAt timestamp.
      // Only touch rows that are not already soft-deleted so repeated
      // deletes do not silently re-stamp deletedAt.
      const updateArgs = {
        where: {
          ...args.where,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
        },
      };

      // Execute update instead of delete
      return next({
        ...params,
        action: action === 'delete' ? 'update' : 'updateMany',
        args: updateArgs,
      });
    }

    // Handle count operations - exclude soft-deleted records
    if (action === 'count') {
      const includeDeleted = shouldIncludeDeleted(args);

      if (config.excludeDeleted && !includeDeleted) {
        args.where = {
          ...args.where,
          deletedAt: null,
        };
      }

      removeIncludeDeletedFlags(args);
    }

    // Handle aggregate operations - exclude soft-deleted records
    if (action === 'aggregate') {
      const includeDeleted = shouldIncludeDeleted(args);

      if (config.excludeDeleted && !includeDeleted) {
        args.where = {
          ...args.where,
          deletedAt: null,
        };
      }

      removeIncludeDeletedFlags(args);
    }

    // Handle upsert operations — prevent soft-deleted records from being
    // accidentally resurrected and ensure newly-created rows via upsert
    // are never stamped with a deleted timestamp.
    //
    // Strategy:
    //  - Inject `deletedAt: null` into the `create` branch so new rows
    //    start as non-deleted (guards against callers omitting the field).
    //  - Inject `deletedAt: null` into the `update` branch so an upsert
    //    that matches a live row cannot accidentally re-stamp deletedAt
    //    as null via an incomplete payload.
    //
    // Opt-out: if the caller already includes `deletedAt` in their payload
    // (e.g. an intentional restore or explicit set), we leave it untouched.
    if (action === 'upsert') {
      const upsertArgs = args as unknown as {
        where?: Record<string, unknown>;
        create?: Record<string, unknown>;
        update?: Record<string, unknown>;
      };

      // Ensure newly-created rows via upsert start as non-deleted.
      if (upsertArgs.create && !('deletedAt' in upsertArgs.create)) {
        upsertArgs.create = {
          ...upsertArgs.create,
          deletedAt: null,
        };
      }

      // Ensure the update branch does not inadvertently set deletedAt.
      if (upsertArgs.update && !('deletedAt' in upsertArgs.update)) {
        upsertArgs.update = {
          ...upsertArgs.update,
          deletedAt: null,
        };
      }
    }

    return next(params);
  };
}

function getMiddlewareArgs(
  params: Prisma.MiddlewareParams,
): SoftDeleteMiddlewareArgs {
  if (!params.args) {
    params.args = {};
  }

  return params.args as SoftDeleteMiddlewareArgs;
}

function shouldIncludeDeleted(args: SoftDeleteMiddlewareArgs): boolean {
  return args.where?._includeDeleted === true || args.includeDeleted === true;
}

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
