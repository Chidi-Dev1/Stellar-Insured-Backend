import { Prisma } from '@prisma/client';

/**
 * A Prisma transaction client or the root PrismaService – anything that
 * exposes the model delegates.  Repositories accept this so callers can
 * enlist them in an existing transaction.
 */
export type TransactionClient = Prisma.TransactionClient;

/**
 * Generic read/write repository interface with full Prisma type safety.
 * T = the Prisma model type (e.g. User, InsurancePolicy)
 * CreateInput = the model's create input type
 * UpdateInput = the model's update input type
 * ID = the primary-key type (defaults to string)
 */
export interface IRepository<
  T,
  CreateInput extends Record<string, unknown> = Record<string, unknown>,
  UpdateInput extends Record<string, unknown> = Record<string, unknown>,
  ID = string
> {
  findById(id: ID, tx?: TransactionClient): Promise<T | null>;
  findMany(
    args?: Prisma.Args<any, 'findMany'>,
    tx?: TransactionClient,
  ): Promise<T[]>;
  create(data: CreateInput, tx?: TransactionClient): Promise<T>;
  update(
    id: ID,
    data: UpdateInput,
    tx?: TransactionClient,
  ): Promise<T>;
  delete(id: ID, tx?: TransactionClient): Promise<T>;
  /**
   * Execute operations in a transaction
   */
  transaction<R>(fn: (tx: TransactionClient) => Promise<R>): Promise<R>;
}

/**
 * Extends IRepository with soft-delete helpers.
 */
export interface ISoftDeleteRepository<
  T,
  CreateInput extends Record<string, unknown> = Record<string, unknown>,
  UpdateInput extends Record<string, unknown> = Record<string, unknown>,
  ID = string
> extends IRepository<T, CreateInput, UpdateInput, ID> {
  softDelete(id: ID, tx?: TransactionClient): Promise<T>;
  restore(id: ID, tx?: TransactionClient): Promise<T>;
  softDeleteMany(where: Record<string, unknown>, tx?: TransactionClient): Promise<number>;
}