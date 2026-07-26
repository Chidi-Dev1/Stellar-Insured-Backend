import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ClaimStatus } from './enums/claim-status.enum';
import { PolicyStatus } from './enums/policy-status.enum';
import { AuditAction } from './enums/audit-action.enum';
import { PrismaService } from '../prisma.service';
import { PoolService } from './pool.service';
import { AuditService } from './services/audit.service';
import { ReputationService } from '../reputation/reputation.service';
import { REPUTATION_DELTAS } from '../reputation/reputation.constants';
import { Claim, InsurancePolicy, Prisma } from '@prisma/client';
import { updateTracingContext } from '../common/tracing/tracing-context';

type ClaimWithPolicy = Claim & { policy: InsurancePolicy };

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pools: PoolService,
    private readonly auditService: AuditService,
    private readonly reputationService: ReputationService,
  ) {}

  async assessClaim(claimId: string): Promise<ClaimWithPolicy> {
    updateTracingContext({ entityId: claimId });
    const claim = (await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { policy: true },
    })) as ClaimWithPolicy | null;

    if (!claim) {
      throw new NotFoundException(`Claim with ID ${claimId} not found`);
    }

    const policy = claim.policy;
    if (!policy) {
      throw new NotFoundException(`Policy for claim ${claimId} not found`);
    }

    const beforeState = { ...claim };

    if (policy.status !== PolicyStatus.ACTIVE) {
      const reason = `Policy is not active: ${policy.status}`;
      await this.updateStatus(
        claimId,
        ClaimStatus.REJECTED,
        reason,
        'system',
      );
      throw new BadRequestException('Cannot approve claim for inactive policy');
    }

    if ((claim.claimAmount as Prisma.Decimal).gt(policy.coverageAmount as Prisma.Decimal)) {
      const reason = 'Claim amount exceeds coverage';
      await this.updateStatus(
        claimId,
        ClaimStatus.REJECTED,
        reason,
        'system',
      );
      throw new BadRequestException('Claim amount exceeds policy coverage amount');
    }

    const isFraudulent = await this.runFraudDetection(claim);
    if (isFraudulent) {
      this.logger.warn(`Fraud detection triggered for claim ${claimId}`);
      await this.auditService.log(
        AuditAction.FRAUD_DETECTED,
        'Claim',
        claimId,
        beforeState,
        claim,
        undefined,
        'High fraud risk score detected',
      );
      // Adjust reputation for fraud detection
      await this.reputationService.adjustReputation(
        policy.userId,
        REPUTATION_DELTAS.FRAUD_DETECTED,
        `Fraud detected on claim ${claimId}`,
      );
    }

    const oracleVerified = await this.verifyOracle(claimId);
    if (!oracleVerified) {
      const reason = 'Oracle verification failed';
      await this.updateStatus(
        claimId,
        ClaimStatus.REJECTED,
        reason,
        'system',
      );
      throw new BadRequestException('Oracle verification failed');
    }

    const updatedClaim = await this.prisma.$transaction(async tx => {
      const result = await tx.claim.update({
        where: { id: claimId },
        data: { status: ClaimStatus.APPROVED, payoutAmount: claim.claimAmount },
        include: { policy: true },
      });
      await this.auditService.logApprove(
        'Claim',
        claimId,
        beforeState,
        result,
      );
      return result;
    });

    // Adjust reputation after the transaction commits
    await this.reputationService.adjustReputation(
      policy.userId,
      REPUTATION_DELTAS.CLAIM_APPROVED,
      `Claim ${claimId} approved`,
    );

    return updatedClaim;
  }

  private async updateStatus(
    claimId: string,
    status: ClaimStatus,
    reason: string,
    _user: string = 'system',
    additionalData: { payoutAmount?: Prisma.Decimal } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<ClaimWithPolicy> {
    const execute = async (client: Prisma.TransactionClient) => {
      const existing = (await client.claim.findUnique({
        where: { id: claimId },
        include: { policy: true },
      })) as ClaimWithPolicy | null;
      if (!existing) throw new NotFoundException('Claim not found');

      const beforeState = { ...existing };
      const updated = (await client.claim.update({
        where: { id: claimId },
        data: {
          status,
          ...(additionalData.payoutAmount !== undefined && {
            payoutAmount: additionalData.payoutAmount,
          }),
        },
        include: { policy: true },
      })) as ClaimWithPolicy;

      if (status === ClaimStatus.REJECTED) {
        if (existing.policy) {
          const claimDecimal = new Prisma.Decimal(existing.claimAmount);
          await this.pools.unlockCapital(existing.policy.poolId, claimDecimal, tx);
        }
        await this.auditService.logReject('Claim', claimId, beforeState, updated, reason, tx);
      } else if (status === ClaimStatus.APPROVED) {
        await this.auditService.logApprove(
          'Claim',
          updated.id,
          beforeState,
          updated,
          undefined,
          reason,
          tx,
        );
      }

      return updated;
    };

    const result = tx ? await execute(tx) : await this.prisma.$transaction(execute);

    // Adjust reputation outside the transaction so it doesn't block the commit.
    // Only fires for REJECTED status; APPROVED is handled directly in assessClaim.
    if (status === ClaimStatus.REJECTED) {
      const userId = result.policy?.userId;
      if (userId) {
        try {
          await this.reputationService.adjustReputation(
            userId,
            REPUTATION_DELTAS.CLAIM_REJECTED,
            `Claim ${claimId} rejected: ${reason}`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Failed to adjust reputation for claim rejection ${claimId}: ${msg}`);
        }
      }
    }

    return result;
  }

  private async runFraudDetection(claim: Claim): Promise<boolean> {
    const fraudIndicators: string[] = [];

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const duplicateClaims = await this.prisma.claim.count({
      where: {
        policyId: claim.policyId,
        claimAmount: claim.claimAmount,
        status: { not: ClaimStatus.REJECTED },
        id: { not: claim.id },
        createdAt: { gt: thirtyDaysAgo },
      },
    });

    if (duplicateClaims > 0) {
      fraudIndicators.push('DUPLICATE_CLAIM');
    }

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const recentClaims = await this.prisma.claim.count({
      where: {
        policyId: claim.policyId,
        createdAt: { gt: ninetyDaysAgo },
      },
    });

    if (recentClaims >= 3) {
      fraudIndicators.push('HIGH_FREQUENCY');
    }

    const claimDate = new Date(claim.createdAt);
    const hour = claimDate.getHours();
    const dayOfWeek = claimDate.getDay();

    if (hour < 6 || hour > 22 || dayOfWeek === 0 || dayOfWeek === 6) {
      fraudIndicators.push('UNUSUAL_TIMING');
    }

    if (fraudIndicators.length > 0) {
      this.logger.warn(
        `Fraud indicators detected for claim ${claim.id}: ${fraudIndicators.join(', ')}`,
      );
    }

    return fraudIndicators.length >= 2;
  }

  private async verifyOracle(claimId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    try {
      const client = tx ?? this.prisma;
      const claim = (await client.claim.findUnique({
        where: { id: claimId },
        include: { policy: true },
      })) as ClaimWithPolicy | null;
      if (!claim || !claim.policy) return false;

      const policy = claim.policy;
      const now = new Date();
      if (
        policy.status !== PolicyStatus.ACTIVE ||
        (policy.endDate && policy.endDate < now)
      ) {
        return false;
      }

      const claimDecimal = claim.claimAmount as Prisma.Decimal;
      const coverageDecimal = policy.coverageAmount as Prisma.Decimal;

      if (claimDecimal.lte(new Prisma.Decimal(0)) || claimDecimal.gt(coverageDecimal)) {
        return false;
      }

      await this.auditService.log(
        AuditAction.ORACLE_VERIFIED,
        'Claim',
        claimId,
        undefined,
        undefined,
        undefined,
        'Oracle verification successful',
        tx,
      );

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Oracle verification failed: ${message}`);
      return false;
    }
  }

  async payClaim(claimId: string): Promise<ClaimWithPolicy> {
    updateTracingContext({ entityId: claimId });
    return await this.prisma.$transaction(async tx => {
      const claim = (await tx.claim.findUnique({
        where: { id: claimId },
        include: { policy: true },
      })) as ClaimWithPolicy | null;
      if (!claim) {
        throw new NotFoundException(`Claim with ID ${claimId} not found`);
      }
      const beforeState = { ...claim };
      const updatedClaim = (await tx.claim.update({
        where: { id: claimId },
        data: { status: ClaimStatus.PAID },
        include: { policy: true },
      })) as ClaimWithPolicy;
      if (claim.policy) {
        const claimDecimal = new Prisma.Decimal(claim.claimAmount);
        await this.pools.unlockCapital(claim.policy.poolId, claimDecimal, tx);
      }
      await this.auditService.logPayout(
        'Claim',
        claimId,
        beforeState,
        updatedClaim,
        undefined,
        undefined,
        tx,
      );
      return updatedClaim;
    });
  }

  async createClaim(policyId: string, claimAmount: Prisma.Decimal): Promise<Claim> {
    const savedClaim = await this.prisma.claim.create({
      data: {
        policyId,
        claimAmount,
        status: ClaimStatus.PENDING,
      },
    });
    updateTracingContext({ entityId: savedClaim.id });
    await this.auditService.logCreate('Claim', savedClaim.id, savedClaim);
    return savedClaim;
  }
}
