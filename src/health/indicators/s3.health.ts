import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * S3 storage health indicator.
 * Healthy: HeadBucket succeeds (bucket exists and accessible).
 * Unhealthy: auth failure, bucket missing, or network timeout.
 * Classification: OPTIONAL — app can function without S3 for reads,
 * but uploads will fail. Contributes to degraded status, not unhealthy.
 */
@Injectable()
export class S3HealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(S3HealthIndicator.name);
  private s3: S3Client;
  private bucket: string;
  private readonly HEALTH_CHECK_TIMEOUT = 5000; // 5 second timeout

  constructor(private readonly config: ConfigService) {
    super();
    const region = this.config.get<string>('AWS_REGION');
    const accessKeyId = this.config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('AWS_SECRET_ACCESS_KEY');
    this.bucket = this.config.get<string>('AWS_S3_BUCKET') || '';

    if (!region || !accessKeyId || !secretAccessKey || !this.bucket) {
      this.logger.warn(
        'S3 health indicator: missing AWS configuration (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET)',
      );
    }

    this.s3 = new S3Client({
      region: region || 'us-east-1',
      credentials: accessKeyId && secretAccessKey 
        ? { accessKeyId, secretAccessKey }
        : undefined,
    });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      // Check if bucket is configured
      if (!this.bucket) {
        throw new Error('S3 bucket not configured');
      }

      const command = new HeadBucketCommand({ Bucket: this.bucket });
      
      // Execute HeadBucket with timeout
      await Promise.race([
        this.s3.send(command),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`S3 health check timeout after ${this.HEALTH_CHECK_TIMEOUT}ms`)),
            this.HEALTH_CHECK_TIMEOUT,
          ),
        ),
      ]);

      return this.getStatus(key, true, {
        type: 's3',
        status: 'connected',
        message: `S3 bucket "${this.bucket}" is accessible`,
        bucket: this.bucket,
      });
    } catch (error) {
      this.logger.warn(
        `S3 health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new HealthCheckError(
        'S3 health check failed',
        this.getStatus(key, false, {
          type: 's3',
          status: 'down',
          bucket: this.bucket,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  }
}
