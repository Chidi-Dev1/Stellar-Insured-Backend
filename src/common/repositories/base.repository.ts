import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { IRepository, TransactionClient } from './repository.interface';

/**
 * Generic base repository with full Prisma type safety.
 *
 * Subclasses must supply `modelName` (the Prisma delegate key, e.g. "user",
 * "insurancePolicy") and may override any method to add model-specific logic.
 *
 * Every method accepts an optional `tx` so the caller can enlist the
 * repository in a Prisma interactive transaction.
 */
export abstract class BaseRepository<
  T,
  CreateInput extends Record<string, unknown> = Record<string, unknown>,
  UpdateInput extends Record<string, unknown> = Record<string, unknown>,
  ID = string
> implements IRepository<T, CreateInput, UpdateInput, ID> {
  constructor(
    protected readonly prisma: PrismaService,
    /** Key on the PrismaClient delegate, e.g. "user" */
    protected readonly modelName: string,
  ) {}

  /** Returns the Prisma model delegate, honoring tx when provided. */
  protected delegate(tx?: TransactionClient): any {
    const client: any = tx ?? this.prisma;
    return client[this.modelName];
  }

  async findById(id: ID, tx?: TransactionClient): Promise<T | null> {
    return this.delegate(tx).findUnique({ where: { id } }) as Promise<T | null>;
  }

  async findMany(
    args: Record<string, unknown> = {},
    tx?: TransactionClient,
  ): Promise<T[]> {
    return this.delegate(tx).findMany(args) as Promise<T[]>;
  }

  async create(
    data: Record<string, unknown>,
    tx?: TransactionClient,
  ): Promise<T> {
    return this.delegate(tx).create({ data }) as Promise<T>;
  }

  async update(
    id: ID,
    data: Record<string, unknown>,
    tx?: TransactionClient,
  ): Promise<T> {
    return this.delegate(tx).update({ where: { id }, data }) as Promise<T>;
  }

  /**
   * Soft-delete a record by its primary key.
   *
   * Despite the name, this issues a `prisma[model].delete()` which the
   * soft-delete middleware intercepts and converts to:
   *
   *   `UPDATE … SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`
   *
   * The row is **not** removed from the database — it is hidden from standard
   * queries but can be recovered via `SoftDeleteRepository.restore()` or
   * `SoftDeleteService.restore()`.
   *
   * To permanently remove a row, use `SoftDeleteService.hardDelete()`.
   *
   * See SOFT_DELETE_GUIDE.md §5.2
   */
  async delete(id: ID, tx?: TransactionClient): Promise<T> {
    return this.delegate(tx).delete({ where: { id } }) as Promise<T>;
  }

  /** Convenience: findById and throw NotFoundException when missing. */
  async findByIdOrFail(id: ID, tx?: TransactionClient): Promise<T> {
    const record = await this.findById(id, tx);
    if (!record) {
      throw new NotFoundException(`${this.modelName} with id ${id} not found`);
    }
    return record;
  }

  /** Convenience: count records matching the given where clause. */
  async count(
    where: Record<string, unknown> = {},
    tx?: TransactionClient,
  ): Promise<number> {
    return this.delegate(tx).count({ where }) as Promise<number>;
  }

  /** Wraps prisma.$transaction so callers don't need to import PrismaService. */
  async transaction<R>(fn: (tx: TransactionClient) => Promise<R>): Promise<R> {
    return this.prisma.$transaction(fn);
  }
}