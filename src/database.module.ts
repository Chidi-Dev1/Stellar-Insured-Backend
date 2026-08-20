import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Core database module.
 *
 * Provides and exports `PrismaService` — the single entry point for all
 * database access across the application.
 *
 * ## Soft-delete middleware
 *
 * The soft-delete middleware is registered **once** inside
 * `PrismaService.onModuleInit()` with `{ excludeDeleted: true }`.
 * It is not registered here so that the middleware lifecycle is tied to the
 * `PrismaService` instance rather than to the module graph.
 *
 * Importing `DatabaseModule` is sufficient to get transparent soft-delete
 * behaviour on all supported models.  You do not need to register the
 * middleware yourself.
 *
 * See also: SOFT_DELETE_GUIDE.md §3
 */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
