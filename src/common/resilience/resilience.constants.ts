import { CircuitBreakerOptions } from './circuit-breaker';
import { RetryOptions } from './retry';

/**
 * One circuit-breaker + retry policy per external dependency. Services pass
 * the preset straight to `createCircuitBreaker` / `withResilience`, so every
 * external client shares the same resilience semantics.
 *
 * Policies are deliberately conservative: external calls are allowed a small
 * number of fast in-process retries with exponential backoff before the
 * breaker trips and callers fail fast (or use their fallback).
 */
export interface ResiliencePolicy {
  circuitBreaker: Partial<Omit<CircuitBreakerOptions, 'name'>> & {
    name: string;
  };
  retry?: RetryOptions;
}

/** Stellar Soroban RPC (indexer polling: getHealth / getLatestLedger / getEvents). */
export const STELLAR_RPC_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'stellar-rpc', timeout: 15_000 },
  retry: { attempts: 3, baseDelayMs: 500, maxDelayMs: 5_000, jitter: true },
};

/** AWS S3 (upload / presign / delete). */
export const AWS_S3_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'aws-s3', timeout: 30_000 },
  retry: { attempts: 3, baseDelayMs: 250, maxDelayMs: 4_000, jitter: true },
};

/** IPFS (pin metadata / hash verification). */
export const IPFS_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'ipfs', timeout: 20_000 },
  retry: { attempts: 2, baseDelayMs: 1_000, maxDelayMs: 4_000, jitter: true },
};

/** SendGrid (email delivery). Bull already retries the job, so keep this short. */
export const SENDGRID_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'sendgrid', timeout: 15_000 },
  retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 3_000, jitter: true },
};

/** Web push (VAPID delivery). */
export const WEB_PUSH_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'web-push', timeout: 15_000 },
  retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 3_000, jitter: true },
};

/** Redis-backed cache (nonce store). */
export const REDIS_NONCE_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'redis-nonce', timeout: 3_000 },
  retry: { attempts: 2, baseDelayMs: 200, maxDelayMs: 1_000, jitter: true },
};

/** Bull queue enqueues (email / push / IPFS pin jobs — Redis-backed). */
export const BULL_QUEUE_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'bull-queue', timeout: 5_000 },
  retry: { attempts: 2, baseDelayMs: 200, maxDelayMs: 1_000, jitter: true },
};

/** Idempotency-key COMPLETED write guard (DB, not external — kept for parity). */
export const IDEMPOTENCY_DB_POLICY: ResiliencePolicy = {
  circuitBreaker: { name: 'idempotency-db', timeout: 5_000 },
};
