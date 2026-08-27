import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * Redis health indicator.
 * Healthy: PING returns PONG within 2s.
 * Unhealthy: connection refused, timeout, or auth failure.
 * Required: Critical for session management, caching, and Bull queue operations.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);
  private redisClient: Redis | null = null;
  private readonly PING_TIMEOUT = 2000; // 2 second timeout for PING

  constructor(private readonly config: ConfigService) {
    super();
  }

  private async getRedisClient(): Promise<Redis> {
    if (!this.redisClient) {
      const redisUrl = this.config.get<string>(
        'REDIS_URL',
        'redis://localhost:6379',
      );
      this.redisClient = new Redis(redisUrl, {
        retryStrategy: () => null, // Disable retries for health checks
        enableReadyCheck: false,
        enableOfflineQueue: false,
        connectTimeout: this.PING_TIMEOUT,
      });
    }
    return this.redisClient;
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    let client: Redis | null = null;
    try {
      client = await this.getRedisClient();
      
      // Execute PING with timeout
      const pong = await Promise.race([
        client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Redis PING timeout after ${this.PING_TIMEOUT}ms`)),
            this.PING_TIMEOUT,
          ),
        ),
      ]);

      if (pong !== 'PONG') {
        throw new Error(`Unexpected PING response: ${pong}`);
      }

      return this.getStatus(key, true, {
        type: 'redis',
        status: 'connected',
        message: 'Redis PING successful',
      });
    } catch (error) {
      this.logger.error(
        `Redis health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new HealthCheckError(
        'Redis health check failed',
        this.getStatus(key, false, {
          type: 'redis',
          status: 'down',
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  }
}
