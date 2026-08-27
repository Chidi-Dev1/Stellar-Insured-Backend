import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { PrismaService } from '../../prisma.service';

/**
 * Prisma/PostgreSQL health indicator.
 * Healthy: SELECT 1 query executes successfully within 3s.
 * Unhealthy: connection refused, timeout, or query failure.
 * Required: Critical for all data access and persistence.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(PrismaHealthIndicator.name);
  private readonly HEALTH_CHECK_TIMEOUT = 3000; // 3 second timeout

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    try {
      // Execute SELECT 1 with timeout to verify database connectivity
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Database health check timeout after ${this.HEALTH_CHECK_TIMEOUT}ms`)),
            this.HEALTH_CHECK_TIMEOUT,
          ),
        ),
      ]);

      return this.getStatus(key, true, {
        type: 'postgresql',
        status: 'connected',
        message: 'Database query successful',
      });
    } catch (error) {
      this.logger.error(
        `Prisma/PostgreSQL health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new HealthCheckError(
        'Prisma health check failed',
        this.getStatus(key, false, {
          type: 'postgresql',
          status: 'down',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  }
}
