import { Injectable } from '@nestjs/common';
import { RefreshToken, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { BaseRepository } from '../../common/repositories/base.repository';
import { TransactionClient } from '../../common/repositories/repository.interface';

@Injectable()
export class RefreshTokenRepository extends BaseRepository<RefreshToken> {
  constructor(prisma: PrismaService) {
    super(prisma, 'refreshToken');
  }

  /**
   * Create a new refresh token record.
   */
  async createToken(
    data: {
      token: string;
      userId: string;
      familyId: string;
      expiresAt: Date;
      fingerprint?: string;
    },
    tx?: TransactionClient,
  ): Promise<RefreshToken> {
    return this.delegate(tx).create({ data });
  }

  /**
   * Find a refresh token by its token string (the actual JWT hash/value).
   */
  async findByToken(
    token: string,
    tx?: TransactionClient,
  ): Promise<RefreshToken | null> {
    return this.delegate(tx).findUnique({ where: { token } });
  }

  /**
   * Find all tokens in a given family.
   * Used for family-based revocation when reuse is detected.
   */
  async findByFamilyId(
    familyId: string,
    tx?: TransactionClient,
  ): Promise<RefreshToken[]> {
    return this.delegate(tx).findMany({
      where: {
        familyId,
        deletedAt: null,
      },
    });
  }

  /**
   * Revoke a specific token by setting revokedAt.
   */
  async revokeToken(
    token: string,
    replacedByToken?: string,
    tx?: TransactionClient,
  ): Promise<RefreshToken> {
    return this.delegate(tx).update({
      where: { token },
      data: {
        revokedAt: new Date(),
        replacedByToken: replacedByToken ?? null,
      },
    });
  }

  /**
   * Revoke all tokens in a family (family-based revocation on abuse detection).
   */
  async revokeFamily(
    familyId: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const result = await this.delegate(tx).updateMany({
      where: {
        familyId,
        deletedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    return result.count;
  }

  /**
   * Revoke all tokens for a user (used on logout).
   */
  async revokeAllForUser(
    userId: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const result = await this.delegate(tx).updateMany({
      where: {
        userId,
        deletedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    return result.count;
  }

  /**
   * Count active (non-revoked, non-expired) tokens for a user.
   * Used for session-limit enforcement.
   */
  async countActiveForUser(
    userId: string,
    tx?: TransactionClient,
  ): Promise<number> {
    return this.delegate(tx).count({
      where: {
        userId,
        deletedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * Purge expired and revoked tokens older than a given age.
   * Used for periodic cleanup.
   */
  async purgeStaleTokens(
    olderThanDays: number,
    tx?: TransactionClient,
  ): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await this.delegate(tx).updateMany({
      where: {
        OR: [
          { expiresAt: { lt: cutoff } },
          { revokedAt: { lt: cutoff, not: null } },
        ],
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });
    return result.count;
  }
}
