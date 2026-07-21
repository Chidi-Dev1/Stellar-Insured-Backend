import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingService } from './pricing.service';
import { PoolService } from './pool.service';
import { RiskType } from './enums/risk-type.enum';
import { PolicyStatus } from './enums/policy-status.enum';
import { PrismaService } from '../prisma.service';
import { AuditService } from './services/audit.service';
import { InsurancePolicy } from '@prisma/client';

@Injectable()
export class InsuranceService {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly pricing: PricingService,
    private readonly pools: PoolService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async purchasePolicy(
    userId: string,
    poolId: string,
    riskType: RiskType,
    coverageAmount: Prisma.Decimal,
  ): Promise<InsurancePolicy> {
    if (!userId || !poolId) {
      throw new BadRequestException('userId and poolId are required');
    }
    if (coverageAmount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Coverage amount must be positive');
    }

    try {
      return await this.prisma.$transaction(async tx => {
        const premium = this.pricing.calculatePremium(riskType, coverageAmount);

        await this.pools.lockCapital(poolId, coverageAmount, tx);

        return tx.insurancePolicy.create({
          data: {
            userId,
            poolId,
            riskType,
            coverageAmount,
            premium,
          },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Purchase policy failed for user ${userId}, pool ${poolId}: ${message}`,
      );
      throw error;
    }
  }

  async cancelPolicy(policyId: string): Promise<InsurancePolicy> {
    const policy = await this.prisma.insurancePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) {
      throw new BadRequestException(`Policy ${policyId} not found`);
    }
    if (policy.status === PolicyStatus.CANCELLED || policy.status === PolicyStatus.EXPIRED) {
      throw new BadRequestException('Policy is already inactive');
    }
    const beforeState = { ...policy };
    const updated = await this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: { status: PolicyStatus.CANCELLED },
    });
    await this.pools.unlockCapital(policy.poolId, policy.coverageAmount as Prisma.Decimal);
    await this.auditService.logUpdate('InsurancePolicy', policyId, beforeState, updated, undefined, 'Policy cancelled');
    return updated;
  }

  async expirePolicy(policyId: string): Promise<InsurancePolicy> {
    const policy = await this.prisma.insurancePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) {
      throw new BadRequestException(`Policy ${policyId} not found`);
    }
    if (policy.status === PolicyStatus.EXPIRED || policy.status === PolicyStatus.CANCELLED) {
      throw new BadRequestException('Policy is already inactive');
    }
    const beforeState = { ...policy };
    const updated = await this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: { status: PolicyStatus.EXPIRED },
    });
    await this.pools.unlockCapital(policy.poolId, policy.coverageAmount as Prisma.Decimal);
    await this.auditService.logUpdate('InsurancePolicy', policyId, beforeState, updated, undefined, 'Policy expired');
    return updated;
  }
}
