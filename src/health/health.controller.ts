import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiOkResponse, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaHealthIndicator } from '../common/health/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { BullHealthIndicator } from './indicators/bull.health';
import { S3HealthIndicator } from './indicators/s3.health';
import { NotificationHealthIndicator } from './indicators/notification.health';

/**
 * Health check endpoints for monitoring application and external dependencies.
 *
 * ENDPOINTS:
 * GET /health/live  — liveness: is the process alive?
 * GET /health/ready — readiness: are all required dependencies up?
 * GET /health       — full status with per-dependency detail
 *
 * RESPONSE CODES:
 * 200 — healthy (all required deps up, optional deps irrelevant)
 * 207 — degraded (all required deps up, one or more optional deps down)
 * 503 — unhealthy (one or more required dependencies down)
 *
 * REQUIRED DEPENDENCIES (503 if down):
 * - PostgreSQL (Prisma): Database queries, persistence, data integrity
 * - Redis: Session management, caching, Bull queue backend
 * - Bull Queue: Job processing (email, push notifications, IPFS pinning)
 *
 * OPTIONAL DEPENDENCIES (207 if down, not 503):
 * - S3 Storage: File uploads; reads degrade, but app continues
 * - SendGrid Notifications: Notification delivery; queued messages may succeed later
 *
 * USAGE:
 * - Kubernetes: use /health/live for livenessProbe, /health/ready for readinessProbe
 * - Load balancers: use /health/ready to route traffic only to healthy instances
 * - Dashboards: use /health for detailed operational status
 * - Incident triage: check /health/ready first; if 503, use /health for per-dependency detail
 */
@ApiTags('Health')
@Controller({ version: VERSION_NEUTRAL, path: 'health' })
@SkipThrottle({ default: true, auth: true })
@Public()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: PrismaHealthIndicator,
    private redis: RedisHealthIndicator,
    private bull: BullHealthIndicator,
    private s3: S3HealthIndicator,
    private notifications: NotificationHealthIndicator,
    private memory: MemoryHealthIndicator,
  ) {}

  /**
   * Liveness Probe — proves the event loop is alive.
   *
   * ALWAYS returns 200 unless process is dead (no response at all).
   * Does NOT check external dependencies.
   * Checks only: memory heap allocation.
   *
   * WHEN TO USE:
   * - Kubernetes livenessProbe: determines if pod should be restarted
   * - If 503 or no response: container is dead or hung
   * - If 200: process is running and can handle signals
   *
   * WHAT IT CHECKS:
   * - Process memory usage (heap < 512 MB threshold)
   *
   * @returns HealthCheckResult with status 'ok' or 'up'
   */
  @Get('live')
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness probe - is the process alive?',
    description:
      'Lightweight check proving the event loop is running. Always 200 unless process is dead. Does not check external dependencies.',
  })
  @ApiOkResponse({
    description: 'Process is alive and responding',
  })
  @ApiResponse({
    status: 503,
    description: 'Process is dead or hung (rarely returns this; no response is more common)',
  })
  async liveness() {
    return this.health.check([
      () =>
        this.memory.checkHeap('memory_heap', 512 * 1024 * 1024), // 512 MB
    ]);
  }

  /**
   * Readiness Probe — all REQUIRED dependencies are up.
   *
   * Returns 200 if PostgreSQL, Redis, and Bull queue are ALL healthy.
   * Returns 503 if ANY required dependency is down.
   * Does NOT include optional dependencies (S3, SendGrid).
   *
   * WHEN TO USE:
   * - Kubernetes readinessProbe: determines if pod should receive traffic
   * - Load balancers: route traffic only to instances with 200
   * - Smoke tests: verify app can process requests
   * - If 503: remove pod from rotation, page on-call if persistent
   *
   * WHAT IT CHECKS (all REQUIRED):
   * - PostgreSQL (SELECT 1 within 3s)
   * - Redis (PING within 2s)
   * - Bull Queue (getJobCounts within 3s)
   *
   * DOES NOT CHECK (optional):
   * - S3 storage
   * - SendGrid notifications
   *
   * @returns HealthCheckResult with status 'ok' (200) or throws 503
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe - all required dependencies up?',
    description:
      'Checks PostgreSQL, Redis, and Bull queue. Returns 200 if all up, 503 if any down. Does not check optional dependencies. Used for traffic routing and deployment readiness.',
  })
  @ApiOkResponse({
    description: 'All required dependencies (Database, Redis, Queue) are healthy',
  })
  @ApiResponse({
    status: 503,
    description: 'One or more required dependencies (DB, Redis, or Queue) is down',
  })
  async readiness() {
    return this.health.check([
      // REQUIRED — any failure causes 503
      () => this.db.pingCheck('database'),
      () => this.redis.isHealthy('redis'),
      () => this.bull.isHealthy('queue'),
    ]);
  }

  /**
   * Full Health Status — all dependencies with per-dependency detail.
   *
   * Returns 200 if all dependencies (required and optional) are up.
   * Returns 207 (degraded) if required deps up but optional deps down.
   * Returns 503 if any required dependency is down.
   *
   * Includes detailed status for each dependency: type, status, message, counts/config.
   *
   * WHEN TO USE:
   * - Operational dashboards: see full system status
   * - Incident triage: identify which specific dependency is failing
   * - Extended monitoring: track optional dependency availability
   * - Alerting: 207 might indicate degradation worth investigating
   * - Debug: error field in response names the failure reason
   *
   * WHAT IT CHECKS (all dependencies):
   * REQUIRED (503 if down):
   * - PostgreSQL (SELECT 1 within 3s)
   * - Redis (PING within 2s)
   * - Bull Queue (getJobCounts within 3s)
   *
   * OPTIONAL (207 if down, not 503):
   * - S3 Storage (HeadBucket within 5s)
   * - SendGrid Notifications (API key format validation within 5s)
   *
   * ALWAYS CHECKED:
   * - Memory (heap < 512 MB)
   *
   * RESPONSE STRUCTURE:
   * {
   *   "status": "ok" | "degraded" | "error",
   *   "info": {
   *     "database": { "status": "up", "type": "postgresql", "message": "...", ... },
   *     "redis": { "status": "up", "type": "redis", "message": "...", ... },
   *     "queue": { "status": "up", "type": "bull", "jobCounts": {...}, ... },
   *     "storage": { "status": "up", "type": "s3", "bucket": "...", ... },
   *     "notifications": { "status": "up", "type": "sendgrid", "message": "...", ... },
   *     "memory_heap": { "status": "up", ... }
   *   },
   *   "error": {
   *     // Only present if status is "degraded" or "error"
   *     // Contains status for failed optional dependencies
   *     "storage": { "status": "down", "error": "...", ... }
   *   }
   * }
   *
   * @returns HealthCheckResult with status 'ok', 'degraded', or throws 503
   */
  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Full health status with per-dependency detail',
    description:
      'Detailed health check of all dependencies (required and optional). Returns 200 if all up, 207 if required up but optional down, 503 if any required down. Includes error details for failed dependencies.',
  })
  @ApiOkResponse({
    description:
      'Detailed health status for all dependencies (required and optional). Status: ok (all up) or degraded (optional down).',
  })
  @ApiResponse({
    status: 207,
    description:
      'Degraded: all required dependencies up, but one or more optional dependencies (S3, SendGrid) down',
  })
  @ApiResponse({
    status: 503,
    description: 'Unhealthy: one or more required dependencies (DB, Redis, or Queue) is down',
  })
  async full() {
    return this.health.check([
      // REQUIRED — any failure causes 503
      () => this.db.pingCheck('database'),
      () => this.redis.isHealthy('redis'),
      () => this.bull.isHealthy('queue'),

      // OPTIONAL — failure causes degraded (207), not 503
      () => this.s3.isHealthy('storage'),
      () => this.notifications.isHealthy('notifications'),

      // Memory check
      () =>
        this.memory.checkHeap('memory_heap', 512 * 1024 * 1024), // 512 MB
    ]);
  }
}
