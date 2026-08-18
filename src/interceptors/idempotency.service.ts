import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  createCircuitBreaker,
  CircuitBreaker,
} from '../common/resilience/circuit-breaker';
import { withResilience } from '../common/resilience/resilience';
import { IDEMPOTENCY_DB_POLICY } from '../common/resilience/resilience.constants';

/** Everything the interceptor knows when it claims an idempotency key. */
export interface IdempotencyClaim {
  key: string;
  method: string;
  endpoint: string;
  requestBody: unknown;
  expiresAt: Date;
}

export interface IdempotencyKeyRecord {
  id: string;
  key: string;
  method: string;
  endpoint: string;
  requestBody: Prisma.JsonValue;
  response: Prisma.JsonValue | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
}

/**
 * Encapsulates the idempotency-key state machine (PENDING -> COMPLETED/FAILED)
 * as its own unit of work.
 *
 * Each transition is a single, atomic row write on the key store, and the
 * COMPLETED write is guarded by a circuit breaker so a transient database
 * failure after the handler committed can never wedge a key in PENDING and
 * block legitimate retries.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly circuitBreaker: CircuitBreaker = createCircuitBreaker(
    IDEMPOTENCY_DB_POLICY.circuitBreaker.name,
    IDEMPOTENCY_DB_POLICY.circuitBreaker,
  );

  constructor(private readonly prisma: PrismaService) {}

  async findExisting(key: string): Promise<IdempotencyKeyRecord | null> {
    return this.prisma.idempotencyKey.findUnique({
      where: { key },
    }) as unknown as Promise<IdempotencyKeyRecord | null>;
  }

  /**
   * Atomically insert the key as PENDING. Returns 'conflict' when a concurrent
   * request created the same key between the interceptor's read and this
   * write (unique-key violation), which the caller maps to a 409.
   */
  async claim(claim: IdempotencyClaim): Promise<'created' | 'conflict'> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: claim.key,
          method: claim.method,
          endpoint: claim.endpoint,
          requestBody: (claim.requestBody ?? {}) as Prisma.InputJsonValue,
          status: 'PENDING',
          expiresAt: claim.expiresAt,
        },
      });
      return 'created';
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return 'conflict';
      }
      throw error;
    }
  }

  /** Re-arm an existing key (expired, or previously FAILED) as PENDING. */
  async resetToPending(
    key: string,
    claim: Omit<IdempotencyClaim, 'key'>,
  ): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        method: claim.method,
        endpoint: claim.endpoint,
        requestBody: (claim.requestBody ?? {}) as Prisma.InputJsonValue,
        response: Prisma.DbNull,
        status: 'PENDING',
        expiresAt: claim.expiresAt,
        deletedAt: null,
      },
    });
  }

  /** Record the cached response after the handler completed successfully. */
  async markCompleted(
    key: string,
    response: unknown,
    statusCode: number,
  ): Promise<void> {
    await withResilience(this.circuitBreaker, () =>
      this.prisma.idempotencyKey.update({
        where: { key },
        data: {
          status: 'COMPLETED',
          response: {
            data: response,
            statusCode,
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    );
  }

  /** Record a handler failure so a retry can re-run the operation safely. */
  async markFailed(
    key: string,
    error: unknown,
    statusCode: number,
  ): Promise<void> {
    const errorMessage =
      error instanceof Error ? error.message : 'Internal server error';
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: 'FAILED',
        response: {
          error: errorMessage,
          statusCode,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
