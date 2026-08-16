import { CircuitBreaker, isCircuitOpenError } from './circuit-breaker';
import { RetryOptions, computeBackoffDelay, sleep } from './retry';

export interface WithResilienceOptions<T> {
  /** Exponential-backoff retry policy applied to non-open failures. */
  retry?: RetryOptions;
  /**
   * Result returned instead of throwing once the circuit is open — the
   * standardised "fail fast, don't pile onto a degraded dependency" hook.
   */
  fallback?: () => T | Promise<T>;
}

/**
 * Run `task` through a shared circuit breaker, applying exponential-backoff
 * retries (when configured) and failing fast with a fallback once the circuit
 * is open.
 *
 * - Each `fire` is a single breaker event: repeated failures trip the circuit.
 * - Once open, `fire` rejects immediately with opossum's
 *   `CircuitBreakerOpenError`; retries stop and the optional fallback runs.
 * - A success resets the breaker's failure count.
 */
export async function withResilience<T>(
  breaker: CircuitBreaker,
  task: () => Promise<T>,
  options: WithResilienceOptions<T> = {},
): Promise<T> {
  const { retry, fallback } = options;
  const attempts = retry ? Math.max(1, retry.attempts) : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return (await breaker.fire(task)) as T;
    } catch (error) {
      lastError = error;

      // Circuit open: fire() fails fast — stop retrying immediately.
      if (isCircuitOpenError(error)) {
        break;
      }

      const shouldRetry =
        retry && attempt < attempts && (retry.retryIf ? retry.retryIf(error, attempt) : true);
      if (!shouldRetry) break;

      const delay = computeBackoffDelay(attempt, retry);
      retry.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  if (isCircuitOpenError(lastError) && fallback) {
    return fallback();
  }
  throw lastError;
}
