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
import { AuditService } from './services/audit.service';
import { Claim, InsurancePolicy, Prisma } from '@prisma/client';

type ClaimWithPolicy = Claim & { policy: InsurancePolicy };

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async assessClaim(claimId: string): Promise<ClaimWithPolicy> {
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

    // 1. Verify policy is active
    if (policy.status !== PolicyStatus.ACTIVE) {
      await this.updateStatus(
        claimId,
        ClaimStatus.REJECTED,
        `Policy is not active: ${policy.status}`,
        'system',
      );
      throw new BadRequestException('Cannot approve claim for inactive policy');
    }

    // 2. Check coverage limits
    if ((claim.claimAmount as Prisma.Decimal).gt(policy.coverageAmount as Prisma.Decimal)) {
      await this.updateStatus(
        claimId,
        ClaimStatus.REJECTED,
        'Claim amount exceeds coverage',
        'system',
      );
      throw new BadRequestException('Claim amount exceeds policy coverage amount');
    }

    // 3. Fraud Detection
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
    }

    // 4. Oracle Verification
    const oracleVerified = await this.verifyOracle(claimId);
    if (!oracleVerified) {
      await this.updateStatus(
        claimId,
        ClaimStatus.REJECTED,
        'Oracle verification failed',
        'system',
      );
      throw new BadRequestException('Oracle verification failed');
    }

    // 5. Automated Approval
    const updatedClaim = (await this.prisma.claim.update({
      where: { id: claimId },
      data: { status: ClaimStatus.APPROVED, payoutAmount: claim.claimAmount },
      include: { policy: true },
    })) as ClaimWithPolicy;

    await this.auditService.logApprove(
      'Claim',
      claimId,
      beforeState,
      updatedClaim,
    );

    return updatedClaim;
  }

  private async updateStatus(
    claimId: string,
    status: ClaimStatus,
    reason: string,
    _user: string = 'system',
    additionalData: { payoutAmount?: Prisma.Decimal } = {},
  ): Promise<ClaimWithPolicy> {
    const existing = (await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { policy: true },
    })) as ClaimWithPolicy | null;
    if (!existing) throw new NotFoundException('Claim not found');

    const beforeState = { ...existing };
    const updated = (await this.prisma.claim.update({
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
      await this.auditService.logReject('Claim', claimId, beforeState, updated, reason);
    } else if (status === ClaimStatus.APPROVED) {
      await this.auditService.logApprove(
        'Claim',
        updated.id,
        beforeState,
        updated,
        undefined,
        reason,
      );
    }

    return updated;
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

  private async verifyOracle(claimId: string): Promise<boolean> {
    try {
      const claim = (await this.prisma.claim.findUnique({
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
      );

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Oracle verification failed: ${message}`);
      return false;
    }
  }

  async payClaim(claimId: string): Promise<ClaimWithPolicy> {
    const claim = (await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { policy: true },
    })) as ClaimWithPolicy | null;
    if (!claim) {
      throw new NotFoundException(`Claim with ID ${claimId} not found`);
    }
    const beforeState = { ...claim };
    const updatedClaim = (await this.prisma.claim.update({
      where: { id: claimId },
      data: { status: ClaimStatus.PAID },
      include: { policy: true },
    })) as ClaimWithPolicy;
    await this.auditService.logPayout(
      'Claim',
      claimId,
      beforeState,
      updatedClaim,
    );
    return updatedClaim;
  }

  async createClaim(policyId: string, claimAmount: Prisma.Decimal): Promise<Claim> {
    // claimAmount is a plain numeric(18,2) column (see prisma/schema.prisma).
    // It is NOT encrypted at rest: assessClaim()/runFraudDetection() compare
    // it directly against policy.coverageAmount and run DB-level equality
    // queries on it. Encrypting it here previously produced ciphertext that
    // was force-cast to a number via parseFloat(), corrupting the value
    // (issue #399, same root cause as InsuranceService.purchasePolicy()).
    const savedClaim = await this.prisma.claim.create({
      data: {
        policyId,
        claimAmount,
        status: ClaimStatus.PENDING,
      },
    });
    await this.auditService.logCreate('Claim', savedClaim.id, savedClaim);
    return savedClaim;
  }
}
