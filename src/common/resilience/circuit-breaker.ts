import OpossumCircuitBreaker from 'opossum';

/**
 * Standardised circuit-breaker configuration backed by opossum. Sensible
 * defaults are applied in `createCircuitBreaker`, so call sites only override
 * what matters for their dependency (timeout, thresholds).
 */
export interface CircuitBreakerOptions {
  /** Human-readable name surfaced in logs and opossum metrics. */
  name: string;
  /** Percentage of requests in the rolling window that must fail to trip. */
  errorThresholdPercentage?: number;
  /** Milliseconds the circuit stays open before one probe request (half-open). */
  resetTimeout?: number;
  /** Minimum requests in the rolling window before the threshold applies. */
  volumeThreshold?: number;
  /** Rolling window length in milliseconds. */
  rollingCountTimeout?: number;
  /** Per-request timeout in milliseconds; fire() rejects when exceeded. */
  timeout?: number;
}

/** Shared breaker instance type — opossum's CircuitBreaker. */
export type CircuitBreaker = OpossumCircuitBreaker;

const DEFAULTS = {
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  volumeThreshold: 5,
  rollingCountTimeout: 10_000,
  timeout: 10_000,
} as const;

/**
 * Create a named circuit breaker around an arbitrary async task.
 *
 * The underlying opossum action simply invokes the task closure passed to
 * `fire`, so a single breaker instance can protect every call site in a
 * service while keeping the breaker's failure statistics coherent.
 */
export function createCircuitBreaker(
  name: string,
  options: Partial<Omit<CircuitBreakerOptions, 'name'>> = {},
): CircuitBreaker {
  return new OpossumCircuitBreaker(
    (task: () => Promise<unknown>) => task(),
    {
      name,
      errorThresholdPercentage:
        options.errorThresholdPercentage ?? DEFAULTS.errorThresholdPercentage,
      resetTimeout: options.resetTimeout ?? DEFAULTS.resetTimeout,
      volumeThreshold: options.volumeThreshold ?? DEFAULTS.volumeThreshold,
      rollingCountTimeout: options.rollingCountTimeout ?? DEFAULTS.rollingCountTimeout,
      timeout: options.timeout ?? DEFAULTS.timeout,
    },
  );
}

/**
 * True when the error is opossum's fail-fast "circuit open" rejection
 * (`CircuitBreakerOpenError`, code `EOPENBREAKER`).
 */
export function isCircuitOpenError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; code?: string };
  return candidate.name === 'CircuitBreakerOpenError' || candidate.code === 'EOPENBREAKER';
}
