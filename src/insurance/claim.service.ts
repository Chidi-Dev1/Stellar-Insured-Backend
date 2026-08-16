import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ClaimStatus } from './enums/claim-status.enum';
import { PolicyStatus } from './enums/policy-status.enum';
import { AuditAction } from './enums/audit-action.enum';
import { REPUTATION_DELTAS } from '../reputation/reputation.constants';
import { PoolService } from './pool.service';
import { AuditService } from './services/audit.service';
import { ReputationService } from '../reputation/reputation.service';
import { Claim, InsurancePolicy, Prisma } from '@prisma/client';
import { ClaimRepository, ClaimWithPolicy } from '../common/repositories/claim.repository';
import { PrismaService } from '../prisma.service';
import { TransactionClient } from '../common/repositories/repository.interface';
import { updateTracingContext } from '../common/tracing/tracing-context';

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pools: PoolService,
    private readonly auditService: AuditService,
    private readonly reputationService: ReputationService,
    private readonly claimRepository: ClaimRepository,
  ) {}

  async assessClaim(claimId: string): Promise<ClaimWithPolicy> {
    return await this.prisma.$transaction(async tx => {
      const claim = await this.claimRepository.findByIdWithPolicy(claimId, tx);
      if (!claim) throw new NotFoundException(`Claim with ID ${claimId} not found`);

      const policy = claim.policy;
      if (!policy) throw new NotFoundException(`Policy for claim ${claimId} not found`);

      if (claim.status !== ClaimStatus.PENDING) {
        return claim as ClaimWithPolicy;
      }

      const beforeState = { ...claim };

      if (policy.status !== PolicyStatus.ACTIVE) {
        const reason = `Policy is not active: ${policy.status}`;
        return await this.rejectClaim(claimId, beforeState, reason, policy, tx);
      }

      if ((claim.claimAmount as Prisma.Decimal).gt(policy.coverageAmount as Prisma.Decimal)) {
        const reason = 'Claim amount exceeds coverage';
        return await this.rejectClaim(claimId, beforeState, reason, policy, tx);
      }

      const isFraudulent = await this.runFraudDetection(claim, tx);
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
          tx,
        );
        await this.reputationService.adjustReputation(
          policy.userId,
          REPUTATION_DELTAS.FRAUD_DETECTED,
          `Fraud detected on claim ${claimId}`,
          tx,
        );
      }

      const oracleVerified = await this.verifyOracle(claimId, tx);
      if (!oracleVerified) {
        const reason = 'Oracle verification failed';
        return await this.rejectClaim(claimId, beforeState, reason, policy, tx);
      }

      const updatedClaim = await this.claimRepository.updateStatusWithPolicy(
        claimId,
        ClaimStatus.APPROVED,
        { payoutAmount: claim.claimAmount },
        tx,
      );
      await this.auditService.logApprove('Claim', claimId, beforeState, updatedClaim, undefined, undefined, tx);
      await this.reputationService.adjustReputation(
        policy.userId,
        REPUTATION_DELTAS.CLAIM_APPROVED,
        `Claim ${claimId} approved`,
        tx,
      );

      return updatedClaim;
    });
  }

  private async rejectClaim(
    claimId: string,
    beforeState: unknown,
    reason: string,
    policy: InsurancePolicy,
    tx: TransactionClient,
  ): Promise<ClaimWithPolicy> {
    const updated = await this.claimRepository.updateStatusWithPolicy(claimId, ClaimStatus.REJECTED, {}, tx);
    await this.pools.unlockCapital(policy.poolId, new Prisma.Decimal(updated.claimAmount), tx);
    await this.auditService.logReject('Claim', claimId, beforeState, updated, reason, tx);
    await this.reputationService.adjustReputation(policy.userId, REPUTATION_DELTAS.CLAIM_REJECTED, `Claim ${claimId} rejected: ${reason}`, tx);
    return updated;
  }

  private async runFraudDetection(claim: Claim, tx: TransactionClient): Promise<boolean> {
    const fraudIndicators: string[] = [];

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const duplicateClaims = await this.claimRepository.countDuplicates(
      claim.policyId,
      claim.claimAmount as Prisma.Decimal,
      claim.id,
      thirtyDaysAgo,
      ClaimStatus.REJECTED,
      tx,
    );
    if (duplicateClaims > 0) fraudIndicators.push('DUPLICATE_CLAIM');

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const recentClaims = await this.claimRepository.countRecent(claim.policyId, ninetyDaysAgo, tx);
    if (recentClaims >= 3) fraudIndicators.push('HIGH_FREQUENCY');

    const claimDate = new Date(claim.createdAt);
    const hour = claimDate.getHours();
    const dayOfWeek = claimDate.getDay();
    if (hour < 6 || hour > 22 || dayOfWeek === 0 || dayOfWeek === 6) {
      fraudIndicators.push('UNUSUAL_TIMING');
    }

    if (fraudIndicators.length > 0) {
      this.logger.warn(`Fraud indicators detected for claim ${claim.id}: ${fraudIndicators.join(', ')}`);
    }

    return fraudIndicators.length >= 2;
  }

  private async verifyOracle(claimId: string, tx: TransactionClient): Promise<boolean> {
    try {
      const claim = await this.claimRepository.findByIdWithPolicy(claimId, tx);
      if (!claim || !claim.policy) return false;

      const policy = claim.policy as InsurancePolicy;
      const now = new Date();
      if (policy.status !== PolicyStatus.ACTIVE || (policy.endDate && policy.endDate < now)) {
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
      if (claim.status === ClaimStatus.PAID) {
        return claim as ClaimWithPolicy;
      }
      const beforeState = { ...claim };
      const updatedClaim = await this.claimRepository.updateStatusWithPolicy(
        claimId,
        ClaimStatus.PAID,
        {},
        tx,
      );
      if (claim.policy) {
        const claimDecimal = new Prisma.Decimal(claim.claimAmount);
        await this.pools.unlockCapital(claim.policy.poolId, claimDecimal, tx);
      }
      await this.auditService.logPayout('Claim', claimId, beforeState, updatedClaim, undefined, undefined, tx);
      return updatedClaim;
    });
  }

  async createClaim(policyId: string, claimAmount: Prisma.Decimal): Promise<Claim> {
    return await this.prisma.$transaction(async tx => {
      const created = await this.claimRepository.createClaim({ policyId, claimAmount, status: ClaimStatus.PENDING }, tx);
      updateTracingContext({ entityId: created.id });
      await this.auditService.logCreate('Claim', created.id, created, undefined, undefined, tx);
      return created;
    });
  }
}