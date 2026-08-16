export interface RetryOptions {
  /** Total attempts including the first (must be >= 1). */
  attempts: number;
  /** Base exponential-backoff delay in ms (doubles each attempt). */
  baseDelayMs: number;
  /** Optional upper bound for the backoff delay in ms. */
  maxDelayMs?: number;
  /** Apply 50-100% random jitter to each delay (avoid thundering herds). */
  jitter?: boolean;
  /** Decide whether a given failure is retryable. Defaults to retrying all. */
  retryIf?: (error: unknown, attempt: number) => boolean;
}

/**
 * Exponential backoff with optional jitter:
 * `base * 2^(attempt - 1)`, capped at `maxDelayMs` when provided.
 */
export function computeBackoffDelay(attempt: number, options: RetryOptions): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = options.baseDelayMs * 2 ** exponent;
  const capped = Math.min(exponential, options.maxDelayMs ?? exponential);
  if (!options.jitter) return capped;
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `operation`, retrying failures with exponential backoff (and optional
 * jitter) until it succeeds, `attempts` is exhausted, or `retryIf` says stop.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = options.retryIf ? options.retryIf(error, attempt) : true;
      if (attempt >= options.attempts || !retryable) throw error;
      await sleep(computeBackoffDelay(attempt, options));
    }
  }
  throw lastError;
}
