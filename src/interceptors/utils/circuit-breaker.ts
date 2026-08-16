/**
 * Compatibility shim.
 *
 * The standardised circuit-breaker utilities now live in
 * `src/common/resilience/`. This module is kept so pre-existing imports of
 * `CircuitBreaker` / `idempotencyCircuitBreaker` keep resolving; new code
 * should import from `src/common/resilience` directly.
 */
import { createCircuitBreaker } from '../../common/resilience/circuit-breaker';

export type { CircuitBreaker, CircuitBreakerOptions } from '../../common/resilience/circuit-breaker';

// Preserved singleton name for any existing importer.
export const idempotencyCircuitBreaker = createCircuitBreaker('idempotency-db');