import {
  createCircuitBreaker,
  isCircuitOpenError,
} from './circuit-breaker';
import { computeBackoffDelay, withRetry } from './retry';
import { withResilience } from './resilience';

describe('computeBackoffDelay', () => {
  it('doubles the base delay on each attempt', () => {
    const options = { attempts: 4, baseDelayMs: 100, jitter: false };
    expect(computeBackoffDelay(1, options)).toBe(100);
    expect(computeBackoffDelay(2, options)).toBe(200);
    expect(computeBackoffDelay(3, options)).toBe(400);
  });

  it('caps the delay at maxDelayMs', () => {
    const options = { attempts: 6, baseDelayMs: 100, maxDelayMs: 250, jitter: false };
    expect(computeBackoffDelay(4, options)).toBe(250);
    expect(computeBackoffDelay(5, options)).toBe(250);
  });

  it('applies 50-100% jitter when enabled', () => {
    const options = { attempts: 3, baseDelayMs: 1000, jitter: true };
    const delay = computeBackoffDelay(2, options);
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1000);
  });
});

describe('withRetry', () => {
  it('succeeds on the second attempt', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');

    await expect(
      withRetry(operation, { attempts: 3, baseDelayMs: 1 }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('exhausts attempts and throws the last error', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('down'));

    await expect(
      withRetry(operation, { attempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow('down');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops early when retryIf says the error is not retryable', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('4xx'));

    await expect(
      withRetry(operation, {
        attempts: 5,
        baseDelayMs: 1,
        retryIf: () => false,
      }),
    ).rejects.toThrow('4xx');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('withResilience', () => {
  it('passes through successful results', async () => {
    const breaker = createCircuitBreaker('chaos-success');
    await expect(withResilience(breaker, () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('retries non-open failures and succeeds', async () => {
    const breaker = createCircuitBreaker('chaos-retry', {
      errorThresholdPercentage: 50,
      volumeThreshold: 3, // 2 failures must NOT trip the circuit
      resetTimeout: 60_000,
    });
    const task = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce('ok');

    await expect(
      withResilience(breaker, task, {
        retry: { attempts: 3, baseDelayMs: 1, jitter: false },
      }),
    ).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('throws the underlying error after retries are exhausted', async () => {
    const breaker = createCircuitBreaker('chaos-exhausted', {
      errorThresholdPercentage: 50,
      volumeThreshold: 10, // never trips during this test
      resetTimeout: 60_000,
    });
    const task = jest.fn().mockRejectedValue(new Error('down'));

    await expect(
      withResilience(breaker, task, {
        retry: { attempts: 3, baseDelayMs: 1, jitter: false },
      }),
    ).rejects.toThrow('down');
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('fails fast without invoking the task once the circuit is open', async () => {
    const breaker = createCircuitBreaker('chaos-open', {
      errorThresholdPercentage: 100,
      volumeThreshold: 1,
      resetTimeout: 60_000,
    });
    let calls = 0;
    const task = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };

    let openError: unknown;
    for (let i = 0; i < 5 && !openError; i++) {
      try {
        await withResilience(breaker, task);
      } catch (error) {
        if (isCircuitOpenError(error)) {
          openError = error;
        } else {
          expect((error as Error).message).toBe('boom');
        }
      }
    }

    expect(openError).toBeDefined();
    const callsWhenOpen = calls;
    await expect(withResilience(breaker, task)).rejects.toMatchObject({
      code: 'EOPENBREAKER',
    });
    expect(calls).toBe(callsWhenOpen);
  });

  it('invokes the fallback when the circuit is open', async () => {
    const breaker = createCircuitBreaker('chaos-fallback', {
      errorThresholdPercentage: 100,
      volumeThreshold: 1,
      resetTimeout: 60_000,
    });
    const task = () => Promise.reject(new Error('boom'));

    await withResilience(breaker, task).catch(() => undefined);

    await expect(
      withResilience(breaker, task, { fallback: () => 'fallback-value' }),
    ).resolves.toBe('fallback-value');
  });

  it('allows a probe request after the reset timeout (half-open recovery)', async () => {
    const breaker = createCircuitBreaker('chaos-recovery', {
      errorThresholdPercentage: 100,
      volumeThreshold: 1,
      resetTimeout: 20,
    });
    const task = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('recovered');

    await expect(withResilience(breaker, task)).rejects.toThrow('boom');
    // Circuit is now open — second call fails fast, task not invoked.
    await expect(withResilience(breaker, task)).rejects.toMatchObject({
      code: 'EOPENBREAKER',
    });
    expect(task).toHaveBeenCalledTimes(1);

    // After resetTimeout elapses, the next call is a probe that may succeed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(withResilience(breaker, task)).resolves.toBe('recovered');
    expect(task).toHaveBeenCalledTimes(2);
  });
});
