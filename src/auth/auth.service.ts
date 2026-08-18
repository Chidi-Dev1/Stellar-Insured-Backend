import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'crypto';
import { NonceService } from '../nonce/nonce.service';
import { UserService } from '../user/user.service';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { AuditService } from '../insurance/services/audit.service';
import { AuditAction } from '../insurance/enums/audit-action.enum';
import { PrismaService } from '../prisma.service';

/** Access-token payload carried inside every JWT. */
export interface AccessTokenPayload {
  sub: string; // user ID
  walletAddress: string;
  type: 'access';
}

/** The shape returned to the client after a successful login or refresh. */
export interface TokenPairResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds until the access token expires
  token_type: string;
}

/**
 * AuthService
 *
 * Orchestrates the wallet-based login flow, refresh-token rotation,
 * and logout/revocation.  Every mutation is wrapped in a Prisma
 * transaction so partial failures never leave dangling sessions.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Access-token TTL parsed from the config (default 15 min). */
  private readonly accessTokenTTL: string;

  /** Refresh-token TTL in milliseconds. */
  private readonly refreshTokenTTL_MS: number;

  /** Maximum concurrent sessions per user before oldest are evicted. */
  private readonly maxSessionsPerUser: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly nonceService: NonceService,
    private readonly userService: UserService,
    private readonly refreshTokenRepo: RefreshTokenRepository,
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {
    this.accessTokenTTL = this.configService.get<string>(
      'JWT_ACCESS_TOKEN_TTL',
      '15m',
    );

    const refreshDays = this.configService.get<number>(
      'JWT_REFRESH_TOKEN_TTL_DAYS',
      7,
    );
    this.refreshTokenTTL_MS = refreshDays * 24 * 60 * 60 * 1000;

    this.maxSessionsPerUser = this.configService.get<number>(
      'AUTH_MAX_SESSIONS_PER_USER',
      5,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Wallet Login
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Authenticate a user via wallet nonce signing.
   *
   * Flow:
   *  1. Validate the nonce belongs to the user and has not been used.
   *  2. Issue an access token + a refresh token bound to a new session family.
   *  3. Enforce session-limit by evicting oldest tokens when exceeded.
   *  4. Emit an audit log.
   */
  async walletLogin(
    userId: string,
    nonce: string,
    fingerprint?: string,
    ip?: string,
  ): Promise<TokenPairResponse> {
    // 1. Consume the nonce (atomic – prevents replay).
    await this.nonceService.consumeNonceForUser(nonce, userId);

    // 2. Verify the user exists.
    const user = await this.userService.findById(userId);

    // 3. Create tokens inside a transaction so partial failure is impossible.
    const familyId = this.generateFamilyId();
    const result = await this.prisma.$transaction(async tx => {
      const accessToken = this.signAccessToken(user.id, user.walletAddress);
      const refreshToken = await this.createRefreshToken(
        user.id,
        familyId,
        fingerprint,
        tx,
      );

      // 4. Enforce session limit – evict oldest active tokens.
      await this.enforceSessionLimit(user.id, tx);

      return { accessToken, refreshToken };
    });

    // 5. Audit log.
    await this.auditService.log(
      AuditAction.LOGIN,
      'AuthSession',
      userId,
      null,
      { type: 'wallet_login', familyId },
      undefined,
      'Wallet login successful',
    );

    this.logger.log(`Wallet login successful for user ${userId}`);

    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: this.parseTTLToSeconds(this.accessTokenTTL),
      token_type: 'Bearer',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Token Refresh (Rotation)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Rotate a refresh token: validate → revoke old → issue new pair.
   *
   * Token-family tracking detects stolen refresh tokens:
   *  - If the token has already been revoked but belongs to the same family,
   *    it means an attacker replayed a previously-rotated token → revoke
   *    the entire family.
   *  - If the token belongs to an unknown family, reject outright.
   */
  async refreshTokens(
    refreshTokenValue: string,
    fingerprint?: string,
    ip?: string,
  ): Promise<TokenPairResponse> {
    const storedToken =
      await this.refreshTokenRepo.findByToken(refreshTokenValue);

    // ── Token not found ──────────────────────────────────────────────────
    if (!storedToken) {
      this.logger.warn(
        `Refresh attempt with unknown token from ${ip ?? 'unknown'}`,
      );
      await this.auditService.log(
        AuditAction.REJECT,
        'RefreshToken',
        'unknown',
        null,
        { reason: 'token_not_found', ip },
        undefined,
        'Refresh token not found',
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    // ── Token expired ────────────────────────────────────────────────────
    if (storedToken.expiresAt < new Date()) {
      this.logger.warn(
        `Refresh attempt with expired token for user ${storedToken.userId}`,
      );
      await this.auditService.log(
        AuditAction.TOKEN_REUSE_DETECTED,
        'RefreshToken',
        storedToken.id,
        { revokedAt: storedToken.revokedAt, expiresAt: storedToken.expiresAt },
        { reason: 'token_expired' },
        undefined,
        'Refresh token expired',
      );
      throw new UnauthorizedException('Refresh token has expired');
    }

    // ── Token revoked → possible replay (abuse detection) ────────────────
    if (storedToken.revokedAt) {
      this.logger.warn(
        `Refresh-token reuse detected for user ${storedToken.userId} ` +
          `family ${storedToken.familyId} — revoking entire family`,
      );
      await this.prisma.$transaction(async tx => {
        await this.refreshTokenRepo.revokeFamily(storedToken.familyId, tx);
      });
      await this.auditService.log(
        AuditAction.TOKEN_REUSE_DETECTED,
        'RefreshToken',
        storedToken.id,
        { familyId: storedToken.familyId },
        { reason: 'token_reuse_detected', revokedAllInFamily: true },
        undefined,
        'Refresh token reuse detected — family revoked',
      );
      throw new UnauthorizedException(
        'Refresh token has been revoked due to reuse detection',
      );
    }

    // ── Fingerprint mismatch ─────────────────────────────────────────────
    if (
      storedToken.fingerprint &&
      fingerprint &&
      storedToken.fingerprint !== fingerprint
    ) {
      this.logger.warn(
        `Refresh-token fingerprint mismatch for user ${storedToken.userId}`,
      );
      await this.auditService.log(
        AuditAction.TOKEN_REUSE_DETECTED,
        'RefreshToken',
        storedToken.id,
        { fingerprint: storedToken.fingerprint },
        { reason: 'fingerprint_mismatch' },
        undefined,
        'Refresh token fingerprint mismatch',
      );
      throw new UnauthorizedException('Refresh token fingerprint mismatch');
    }

    // ── Valid token — rotate atomically ──────────────────────────────────
    const user = await this.userService.findById(storedToken.userId);
    const newFamilyId = storedToken.familyId; // keep the same family

    const result = await this.prisma.$transaction(async tx => {
      // Revoke the old token, recording which token replaced it.
      // We'll know the new token value after creation, so we use a placeholder
      // and update afterwards (within the same transaction).
      const newAccessToken = this.signAccessToken(user.id, user.walletAddress);
      const newRefreshToken = await this.createRefreshToken(
        user.id,
        newFamilyId,
        fingerprint ?? storedToken.fingerprint ?? undefined,
        tx,
      );

      // Now revoke the old one pointing to the new token.
      await this.refreshTokenRepo.revokeToken(
        refreshTokenValue,
        newRefreshToken,
        tx,
      );

      // Enforce session limit.
      await this.enforceSessionLimit(user.id, tx);

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    });

    await this.auditService.log(
      AuditAction.TOKEN_REFRESH,
      'RefreshToken',
      storedToken.id,
      { revokedAt: null },
      { replacedBy: 'new_token', familyId: newFamilyId },
      undefined,
      'Refresh token rotated',
    );

    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: this.parseTTLToSeconds(this.accessTokenTTL),
      token_type: 'Bearer',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Logout / Revocation
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Revoke all refresh tokens for a user (full logout).
   * Optionally revoke a single specific token (targeted logout).
   */
  async logout(
    userId: string,
    specificToken?: string,
    ip?: string,
  ): Promise<{ revoked: number }> {
    let revoked = 0;

    await this.prisma.$transaction(async tx => {
      if (specificToken) {
        const stored = await this.refreshTokenRepo.findByToken(
          specificToken,
          tx,
        );
        if (stored && stored.userId === userId && !stored.revokedAt) {
          await this.refreshTokenRepo.revokeToken(specificToken, undefined, tx);
          revoked = 1;
        }
      } else {
        revoked = await this.refreshTokenRepo.revokeAllForUser(userId, tx);
      }
    });

    await this.auditService.log(
      AuditAction.TOKEN_REVOKE,
      'AuthSession',
      userId,
      { activeTokens: revoked },
      { reason: specificToken ? 'targeted_logout' : 'full_logout' },
      undefined,
      `Logout: revoked ${revoked} token(s)`,
    );

    this.logger.log(`Logout for user ${userId}: revoked ${revoked} token(s)`);

    return { revoked };
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Sign a short-lived access token (JWT).
   */
  private signAccessToken(userId: string, walletAddress: string): string {
    const payload: AccessTokenPayload = {
      sub: userId,
      walletAddress,
      type: 'access',
    };
    return this.jwtService.sign(payload);
  }

  /**
   * Generate a cryptographically random refresh token, hash it, and persist
   * the record.  Returns the *raw* token string given to the client (the
   * DB stores the SHA-256 hash).
   */
  private async createRefreshToken(
    userId: string,
    familyId: string,
    fingerprint?: string,
    tx?: any,
  ): Promise<string> {
    const rawToken = randomBytes(40).toString('base64url');
    const hashedToken = createHash('sha256').update(rawToken).digest('hex');

    const expiresAt = new Date(Date.now() + this.refreshTokenTTL_MS);

    await this.refreshTokenRepo.createToken(
      {
        token: hashedToken,
        userId,
        familyId,
        expiresAt,
        fingerprint: fingerprint
          ? this.hashFingerprint(fingerprint)
          : undefined,
      },
      tx,
    );

    return rawToken;
  }

  /**
   * Enforce a maximum number of concurrent sessions per user by soft-deleting
   * the oldest tokens when the limit is exceeded.
   */
  private async enforceSessionLimit(userId: string, tx?: any): Promise<void> {
    const activeCount = await this.refreshTokenRepo.countActiveForUser(
      userId,
      tx,
    );

    if (activeCount > this.maxSessionsPerUser) {
      const excess = activeCount - this.maxSessionsPerUser;
      // Find and revoke the oldest tokens
      const client: any = tx ?? this.prisma;
      const oldestTokens = await client.refreshToken.findMany({
        where: {
          userId,
          deletedAt: null,
          revokedAt: null,
        },
        orderBy: { createdAt: 'asc' },
        take: excess,
        select: { token: true },
      });

      for (const t of oldestTokens) {
        await this.refreshTokenRepo.revokeToken(t.token, undefined, tx);
      }

      this.logger.debug(
        `Evicted ${oldestTokens.length} oldest session(s) for user ${userId}`,
      );
    }
  }

  /**
   * Generate a unique family ID for tracking token rotation chains.
   */
  private generateFamilyId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Hash a device/session fingerprint for storage (never store raw fingerprints).
   */
  private hashFingerprint(fingerprint: string): string {
    return createHash('sha256').update(fingerprint).digest('hex');
  }

  /**
   * Parse a JWT TTL string (e.g. "15m", "1h") into seconds.
   */
  private parseTTLToSeconds(ttl: string): number {
    const match = /^(\d+)(s|m|h|d)$/.exec(ttl);
    if (!match) return 900; // default 15 min
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 900;
    }
  }
}
