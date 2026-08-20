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
import {
  NotificationService,
  PreparedNotification,
} from '../notification/services/notification.service';
import { NotificationType } from '../notification/enums/notification-type.enum';

/**
 * ## Deletion / lifecycle semantics
 *
 * `InsuranceService` never issues direct `prisma.delete()` or
 * `prisma.update()` calls for record removal.  All mutations go through
 * `InsurancePolicyRepository`, which extends `SoftDeleteRepository`.
 *
 * - **Cancellation / expiry** → `policyRepository.updateStatus()` sets the
 *   `status` column.  The policy row remains live in the database (visible to
 *   standard queries) so that historical reads and audit trails work correctly.
 * - **Soft-delete** (when a policy must be hidden from standard queries) →
 *   call `policyRepository.delete(id)`.  The soft-delete middleware converts
 *   this to `UPDATE … SET deleted_at = NOW()`.
 * - **Hard delete (purge)** → only via `SoftDeleteService.hardDelete()` for
 *   explicitly approved paths (GDPR erasure, admin purge).  Never call
 *   `policyRepository.delete()` with a `hardDelete` flag outside
 *   `SoftDeleteService`.
 *
 * See SOFT_DELETE_GUIDE.md for the full lifecycle state machine.
 */
@Injectable()
export class InsuranceService {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly pricing: PricingService,
    private readonly pools: PoolService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly policyRepository: InsurancePolicyRepository,
    private readonly notifications: NotificationService,
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

    // The idempotency key store is owned by the interceptor (each state
    // transition is its own atomic write), so the domain transaction below
    // never touches it.
    let purchaseNotification: PreparedNotification | null = null;

    const created = await this.prisma.$transaction(async tx => {
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

      updateTracingContext({ entityId: created.id });
      await this.auditService.logPurchase(
        'InsurancePolicy',
        created.id,
        created,
        undefined,
        'Policy purchased',
        tx,
      );

      // Persist the notification row inside the same transaction so it can
      // never reference an uncommitted policy. Queue dispatch happens only
      // after the transaction commits, below.
      purchaseNotification = await this.notifications.prepareNotification(
        userId,
        NotificationType.POLICY_PURCHASED,
        'Policy Purchased',
        `Your ${riskType} policy is now active with coverage of ${coverageAmount.toString()}.`,
        {
          policyId: created.id,
          riskType,
          coverageAmount: coverageAmount.toString(),
        },
        tx,
      );
      return created;
    });

    // Commit boundary — queue notification jobs only after the transaction
    // committed. Best-effort: a queue failure never fails the purchase.
    await this.notifications.dispatchPrepared(purchaseNotification);

    return created;
  }

  async cancelPolicy(policyId: string): Promise<InsurancePolicy> {
    updateTracingContext({ entityId: policyId });
    return await this.prisma.$transaction(async tx => {
      const policy = await this.policyRepository.findById(policyId, tx);
      if (!policy) {
        throw new BadRequestException(`Policy ${policyId} not found`);
      }
      if (
        policy.status === PolicyStatus.CANCELLED ||
        policy.status === PolicyStatus.EXPIRED
      ) {
        return policy;
      }
      const beforeState = { ...policy };
      const updated = await this.policyRepository.updateStatus(
        policyId,
        PolicyStatus.CANCELLED,
        tx,
      );
      await this.pools.unlockCapital(policy.poolId, policy.coverageAmount, tx);
      await this.auditService.logUpdate(
        'InsurancePolicy',
        policyId,
        beforeState,
        updated,
        undefined,
        'Policy cancelled',
        tx,
      );
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
      if (
        policy.status === PolicyStatus.EXPIRED ||
        policy.status === PolicyStatus.CANCELLED
      ) {
        return policy;
      }
      const beforeState = { ...policy };
      const updated = await this.policyRepository.updateStatus(
        policyId,
        PolicyStatus.EXPIRED,
        tx,
      );
      await this.pools.unlockCapital(policy.poolId, policy.coverageAmount, tx);
      await this.auditService.logUpdate(
        'InsurancePolicy',
        policyId,
        beforeState,
        updated,
        undefined,
        'Policy expired',
        tx,
      );
      return updated;
    });
  }
}
