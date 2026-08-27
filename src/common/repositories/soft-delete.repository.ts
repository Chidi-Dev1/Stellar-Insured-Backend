import { PrismaService } from '../../prisma.service';
import {
  ISoftDeleteRepository,
  TransactionClient,
} from './repository.interface';
import { BaseRepository } from './base.repository';

/**
 * Extends `BaseRepository` with explicit soft-delete and restore helpers.
 *
 * ## Relationship to the soft-delete middleware
 *
 * `PrismaService` registers `createSoftDeleteMiddleware({ excludeDeleted: true })`
 * on startup.  This means:
 *
 * - `BaseRepository.delete(id)` → intercepted by middleware →
 *   `UPDATE … SET deleted_at = NOW()` (soft-delete).
 * - `SoftDeleteRepository.softDelete(id)` → calls `update` with
 *   `data.deletedAt = new Date()` → also a soft-delete, bypassing the
 *   middleware conversion (useful when you need explicit timestamp control).
 * - `SoftDeleteRepository.restore(id)` → calls `updateMany` with
 *   `data.deletedAt = null`.  The middleware detects `data.deletedAt === null`
 *   as a restore operation and skips the default `deletedAt IS NULL` filter
 *   on `where`, allowing the deleted row to be reached.
 * - `SoftDeleteRepository.softDeleteMany(where)` → stamps `deletedAt` on all
 *   matching rows in one statement.
 *
 * ## Hard deletes
 *
 * None of the methods in this class issue a hard delete.  For permanent
 * removal, use `SoftDeleteService.hardDelete()` or
 * `SoftDeleteService.hardDeleteMany()`.
 *
 * See SOFT_DELETE_GUIDE.md §5 for the full repository layer reference.
 */
export abstract class SoftDeleteRepository<
  T,
  CreateInput extends Record<string, unknown> = Record<string, unknown>,
  UpdateInput extends Record<string, unknown> = Record<string, unknown>,
  ID = string
> extends BaseRepository<T, CreateInput, UpdateInput, ID>
  implements ISoftDeleteRepository<T, CreateInput, UpdateInput, ID>
{
  constructor(prisma: PrismaService, modelName: string) {
    super(prisma, modelName);
  }

  /**
   * Explicitly stamp `deletedAt` on a single record via an `update` call.
   *
   * Prefer `BaseRepository.delete(id)` (middleware-intercepted) for the
   * normal soft-delete path.  Use `softDelete` directly only when you need
   * fine-grained control over the timestamp or when you want to bypass the
   * middleware's `delete → update` conversion to avoid double-interception.
   *
   * The middleware's update handler adds `deletedAt: null` to `where`, which
   * means only live rows (not already-deleted rows) are affected.
   */
  async softDelete(id: ID, tx?: TransactionClient): Promise<T> {
    return this.delegate(tx).update({
      where: { id },
      data: { deletedAt: new Date() },
    }) as Promise<T>;
  }

  /**
   * Restore a soft-deleted record by clearing `deletedAt`.
   *
   * Uses `updateMany` with `{ id, deletedAt: { not: null } }` so that:
   *   1. Only the target row is affected (filtered by `id`).
   *   2. Only rows that are currently soft-deleted are touched (filtered by
   *      `deletedAt: { not: null }`).
   *   3. The middleware's restore path is triggered because `data.deletedAt
   *      === null`, which skips the default `deletedAt IS NULL` filter on
   *      `where` — allowing deleted rows to be reached.
   *
   * After the `updateMany`, a `findUnique` re-fetches and returns the row.
   * If the record was already live (count === 0), the existing live row is
   * returned unchanged.
   */
  async restore(id: ID, tx?: TransactionClient): Promise<T> {
    const results = await this.delegate(tx).updateMany({
      where: { id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    if (results.count === 0) {
      // Record is already live (or does not exist).
      const record = await this.delegate(tx).findUnique({ where: { id } });
      return record as T;
    }

    return this.delegate(tx).findUnique({ where: { id } }) as Promise<T>;
  }

  /**
   * Soft-delete multiple records matching a `where` clause in one statement.
   *
   * Returns the count of rows that were stamped.  Rows already soft-deleted
   * are not re-stamped (the middleware injects `deletedAt: null` into
   * `where` for `updateMany` operations that are not restores).
   */
  async softDeleteMany(
    where: Record<string, unknown>,
    tx?: TransactionClient,
  ): Promise<number> {
    const result = await this.delegate(tx).updateMany({
      where,
      data: { deletedAt: new Date() },
    });
    return result.count as number;
  }
}
