import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingService } from './pricing.service';
import { PoolService } from './pool.service';
import { RiskType } from './enums/risk-type.enum';
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

        // coverageAmount/premium are stored as plain numeric(18,2) columns (see
        // prisma/schema.prisma). They are NOT encrypted at rest: claim assessment,
        // fraud detection, pool capital locking, and reporting all perform direct
        // arithmetic/equality comparisons and DB-level aggregation on these values
        // (see claim.service.ts, pool.service.ts). Encrypting them here previously
        // produced ciphertext that was force-cast to a number via parseFloat(),
        // silently corrupting every policy's coverage/premium into NaN/garbage.
        // Sensitive-field encryption (e.g. user email) is applied at the
        // service layer for those specific PII fields only — see
        // EncryptionService and user.service.ts.
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
}
