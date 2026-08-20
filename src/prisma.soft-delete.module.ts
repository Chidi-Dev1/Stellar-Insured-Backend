import { Module } from '@nestjs/common';
import { DatabaseModule } from './database.module';
import { SoftDeleteService } from './prisma.soft-delete.service';

/**
 * Provides `SoftDeleteService` to feature modules that need:
 *   - hard-delete (purge) operations
 *   - restore operations
 *   - admin / audit queries over soft-deleted records
 *   - retention-based cleanup
 *
 * The soft-delete **middleware** is registered separately in
 * `PrismaService.onModuleInit()` (inside `DatabaseModule`) and is always
 * active for every Prisma query.  You do **not** need to import this module
 * to benefit from transparent soft-delete filtering on standard queries.
 *
 * Import `SoftDeleteModule` only when your feature needs the advanced
 * `SoftDeleteService` methods listed above.
 *
 * @example
 * ```typescript
 * @Module({
 *   imports: [SoftDeleteModule],
 *   providers: [MyAdminService],
 * })
 * export class MyAdminModule {}
 * ```
 *
 * See also: SOFT_DELETE_GUIDE.md §6
 */
@Module({
  imports: [DatabaseModule],
  providers: [SoftDeleteService],
  exports: [SoftDeleteService],
})
export class SoftDeleteModule {}
