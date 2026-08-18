import {
  Injectable,
  Inject,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { randomBytes } from 'crypto';
import {
  createCircuitBreaker,
  CircuitBreaker,
} from '../common/resilience/circuit-breaker';
import { withResilience } from '../common/resilience/resilience';
import { REDIS_NONCE_POLICY } from '../common/resilience/resilience.constants';

/**
 * NonceService
 *
 * Generates cryptographically secure nonces, stores them in Redis with a TTL,
 * and validates (consuming) them on use — preventing replay attacks.
 *
 * Previously this service was:
 *  - Not declared in any module (could not be injected)
 *  - Not storing generated nonces anywhere (replay prevention was impossible)
 *  - Not integrated into any auth or request validation flow
 *
 * Now:
 *  - Declared in NonceModule and exported for use by AuthModule / guards
 *  - Nonces are stored in Redis with a configurable TTL (default 5 min)
 *  - consumeNonce() atomically validates and deletes the nonce (one-time use)
 */
@Injectable()
export class NonceService {
  private readonly logger = new Logger(NonceService.name);

  /** How long (ms) a nonce remains valid after generation. */
  private readonly NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private readonly NONCE_PREFIX = 'nonce:';
  private readonly NONCE_USER_PREFIX = 'nonce:user:';

  /**
   * Circuit breaker protecting the Redis-backed cache: when Redis degrades,
   * nonce operations fail fast instead of hanging or retrying indefinitely.
   */
  private readonly redisBreaker: CircuitBreaker = createCircuitBreaker(
    REDIS_NONCE_POLICY.circuitBreaker.name,
    REDIS_NONCE_POLICY.circuitBreaker,
  );

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  /**
   * Generate a new nonce, persist it to Redis, and return it.
   * The nonce expires automatically after NONCE_TTL_MS.
   */
  async generateNonce(): Promise<string> {
    const nonce = randomBytes(16).toString('hex');
    const key = this.buildKey(nonce);

    // Store with TTL — value is the creation timestamp for audit purposes.
    await withResilience(
      this.redisBreaker,
      () => this.cache.set(key, Date.now().toString(), this.NONCE_TTL_MS),
      { retry: REDIS_NONCE_POLICY.retry },
    );

    this.logger.debug(`Nonce generated: ${nonce}`);
    return nonce;
  }

  /**
   * Validate and consume a nonce.
   *
   * - Returns true and deletes the nonce if it exists and has not expired.
   * - Throws BadRequestException if the nonce is unknown, already used, or expired.
   *
   * This is atomic enough for single-instance deployments; for distributed
   * setups consider a Lua script or a Redis SET NX / DEL pipeline.
   */
  async consumeNonce(nonce: string): Promise<boolean> {
    if (!nonce || typeof nonce !== 'string') {
      throw new BadRequestException('Invalid nonce format.');
    }

    const key = this.buildKey(nonce);
    const stored = await withResilience(
      this.redisBreaker,
      () => this.cache.get<string>(key),
      { retry: REDIS_NONCE_POLICY.retry },
    );

    if (!stored) {
      this.logger.warn(
        `Nonce validation failed — unknown or expired: ${nonce}`,
      );
      throw new BadRequestException(
        'Nonce is invalid, expired, or has already been used.',
      );
    }

    // Delete immediately so it cannot be replayed.
    await withResilience(this.redisBreaker, () => this.cache.del(key), {
      retry: REDIS_NONCE_POLICY.retry,
    });

    this.logger.debug(`Nonce consumed: ${nonce}`);
    return true;
  }

  /**
   * Create a nonce bound to a specific user ID (wallet address).
   * The nonce is stored in Redis with both the nonce key and a user-binding key
   * so that during wallet login, the nonce can be validated as belonging to that user.
   */
  async createNonce(userId: string): Promise<string> {
    const nonce = randomBytes(16).toString('hex');
    const key = this.buildKey(nonce);
    const userBindingKey = this.buildUserKey(nonce);

    // Store nonce with its creation timestamp (value) and bind it to the userId
    await withResilience(
      this.redisBreaker,
      async () => {
        await this.cache.set(key, Date.now().toString(), this.NONCE_TTL_MS);
        await this.cache.set(userBindingKey, userId, this.NONCE_TTL_MS);
      },
      { retry: REDIS_NONCE_POLICY.retry },
    );

    this.logger.debug(`Nonce created for user ${userId}: ${nonce}`);
    return nonce;
  }

  /**
   * Consume a nonce and verify it belongs to the expected user.
   * Used in the wallet login flow to prevent nonce reuse across different users.
   */
  async consumeNonceForUser(
    nonce: string,
    expectedUserId: string,
  ): Promise<boolean> {
    if (!nonce || typeof nonce !== 'string') {
      throw new BadRequestException('Invalid nonce format.');
    }

    const key = this.buildKey(nonce);
    const userBindingKey = this.buildUserKey(nonce);

    const [stored, boundUserId] = await withResilience(
      this.redisBreaker,
      async () => {
        const [s, u] = await Promise.all([
          this.cache.get<string>(key),
          this.cache.get<string>(userBindingKey),
        ]);
        return [s, u] as const;
      },
      { retry: REDIS_NONCE_POLICY.retry },
    );

    if (!stored) {
      this.logger.warn(
        `Nonce validation failed — unknown or expired: ${nonce}`,
      );
      throw new BadRequestException(
        'Nonce is invalid, expired, or has already been used.',
      );
    }

    if (boundUserId !== expectedUserId) {
      this.logger.warn(
        `Nonce user binding mismatch — expected ${expectedUserId}, got ${boundUserId}`,
      );
      throw new BadRequestException(
        'Nonce does not belong to the specified user.',
      );
    }

    // Delete immediately so it cannot be replayed.
    await withResilience(
      this.redisBreaker,
      async () => {
        await this.cache.del(key);
        await this.cache.del(userBindingKey);
      },
      { retry: REDIS_NONCE_POLICY.retry },
    );

    this.logger.debug(`Nonce consumed for user ${expectedUserId}: ${nonce}`);
    return true;
  }

  /**
   * Check whether a nonce is currently valid without consuming it.
   * Useful for pre-flight checks; prefer consumeNonce() in auth flows.
   */
  async isNonceValid(nonce: string): Promise<boolean> {
    if (!nonce) return false;
    const stored = await withResilience(
      this.redisBreaker,
      () => this.cache.get<string>(this.buildKey(nonce)),
      { retry: REDIS_NONCE_POLICY.retry },
    );
    return stored !== null && stored !== undefined;
  }

  private buildKey(nonce: string): string {
    return `${this.NONCE_PREFIX}${nonce}`;
  }

  private buildUserKey(nonce: string): string {
    return `${this.NONCE_USER_PREFIX}${nonce}`;
  }
}
