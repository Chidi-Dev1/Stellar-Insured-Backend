import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from '../common/health/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { BullHealthIndicator } from './indicators/bull.health';
import { S3HealthIndicator } from './indicators/s3.health';
import { NotificationHealthIndicator } from './indicators/notification.health';
import { QueueModule } from '../queue.module';

@Module({
  imports: [TerminusModule, QueueModule],
  controllers: [HealthController],
  providers: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    BullHealthIndicator,
    S3HealthIndicator,
    NotificationHealthIndicator,
  ],
})
export class HealthModule {}
