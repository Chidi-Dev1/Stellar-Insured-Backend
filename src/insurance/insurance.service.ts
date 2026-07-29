import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingService } from './pricing.service';
import { PoolService } from './pool.service';
import { RiskType } from './enums/risk-type.enum';
import { PolicyStatus } from './enums/policy-status.enum';
import { AuditService } from './services/audit.service';
import { InsurancePolicy } from '@prisma/client';
import { InsurancePolicyRepository } from '../common/repositories/insurance-policy.repository';
import { PrismaService } from '../prisma.service';
import { updateTracingContext } from '../common/tracing/tracing-context';

@Injectable()
export class InsuranceService {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly pricing: PricingService,
    private readonly pools: PoolService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly policyRepository: InsurancePolicyRepository,
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
        // Check if user already has an active policy for this pool to prevent duplicates (idempotent operation)
        const existingPolicy = await tx.insurancePolicy.findFirst({
          where: {
            userId,
            poolId,
            status: {
              in: [PolicyStatus.ACTIVE, PolicyStatus.PENDING],
            },
          },
        });

        if (existingPolicy) {
          return existingPolicy;
        }

        const premium = this.pricing.calculatePremium(riskType, coverageAmount);
        await this.pools.lockCapital(poolId, coverageAmount, tx);
        const created = await this.policyRepository.createPolicy(
          { userId, poolId, riskType, coverageAmount, premium },
          tx,
        );

        const created = await tx.insurancePolicy.create({
          data: {
            userId,
            poolId,
            riskType,
            coverageAmount,
            premium,
          },
        });
        updateTracingContext({ entityId: created.id });
        await this.auditService.logPurchase('InsurancePolicy', created.id, created, undefined, 'Policy purchased');
        return created;
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Purchase policy failed for user ${userId}, pool ${poolId}: ${message}`);
      throw error;
    }
  }

  async cancelPolicy(policyId: string): Promise<InsurancePolicy> {
    updateTracingContext({ entityId: policyId });
    return await this.prisma.$transaction(async tx => {
      const policy = await this.policyRepository.findById(policyId, tx);
      if (!policy) {
        throw new BadRequestException(`Policy ${policyId} not found`);
      }
      // If policy is already inactive, return it without performing any mutations (idempotent operation)
      if (policy.status === PolicyStatus.CANCELLED || policy.status === PolicyStatus.EXPIRED) {
        return policy;
      }
      const beforeState = { ...policy };
      const updated = await this.policyRepository.updateStatus(policyId, PolicyStatus.CANCELLED, tx);
      await this.pools.unlockCapital(policy.poolId, policy.coverageAmount as Prisma.Decimal, tx);
      await this.auditService.logUpdate('InsurancePolicy', policyId, beforeState, updated, undefined, 'Policy cancelled', tx);
      return updated;
    });
  }

  async expirePolicy(policyId: string): Promise<InsurancePolicy> {
    updateTracingContext({ entityId: policyId });
    return await this.prisma.$transaction(async tx => {
      const policy = await this.policyRepository.findById(policyId, tx);
      if (!policy) {
        throw new BadRequestException(`Policy ${policyId} not found`);
      }
      // If policy is already inactive, return it without performing any mutations (idempotent operation)
      if (policy.status === PolicyStatus.EXPIRED || policy.status === PolicyStatus.CANCELLED) {
        return policy;
      }
      const beforeState = { ...policy };
      const updated = await this.policyRepository.updateStatus(policyId, PolicyStatus.EXPIRED, tx);
      await this.pools.unlockCapital(policy.poolId, policy.coverageAmount as Prisma.Decimal, tx);
      await this.auditService.logUpdate('InsurancePolicy', policyId, beforeState, updated, undefined, 'Policy expired', tx);
      return updated;
    });
  }
}