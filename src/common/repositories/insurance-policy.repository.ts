import { Injectable } from '@nestjs/common';
import { Prisma, InsurancePolicy, PolicyStatus } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { SoftDeleteRepository } from '../repositories/soft-delete.repository';
import { TransactionClient } from '../repositories/repository.interface';

@Injectable()
export class InsurancePolicyRepository extends SoftDeleteRepository<InsurancePolicy> {
  constructor(prisma: PrismaService) {
    super(prisma, 'insurancePolicy');
  }

  async findByIdWithRelations(
    id: string,
    tx?: TransactionClient,
  ): Promise<(InsurancePolicy & { policy?: InsurancePolicy }) | null> {
    return this.delegate(tx).findUnique({ where: { id } });
  }

  /**
   * Idempotency lookup for purchase: a user may hold at most one live
   * (ACTIVE or PENDING) policy per pool. Goes through the repository so
   * callers never issue a second, parallel `tx.insurancePolicy.create`.
   */
  async findActiveOrPendingByUserAndPool(
    userId: string,
    poolId: string,
    tx?: TransactionClient,
  ): Promise<InsurancePolicy | null> {
    return this.delegate(tx).findFirst({
      where: {
        userId,
        poolId,
        status: { in: [PolicyStatus.ACTIVE, PolicyStatus.PENDING] },
      },
    });
  }

  async createPolicy(
    data:
      | Prisma.InsurancePolicyCreateInput
      | Prisma.InsurancePolicyUncheckedCreateInput,
    tx?: TransactionClient,
  ): Promise<InsurancePolicy> {
    return this.delegate(tx).create({ data });
  }

  async updateStatus(
    id: string,
    status: string,
    tx?: TransactionClient,
  ): Promise<InsurancePolicy> {
    return this.delegate(tx).update({ where: { id }, data: { status } });
  }

  async updateMany(
    where: Prisma.InsurancePolicyWhereInput,
    data: Prisma.InsurancePolicyUpdateManyMutationInput,
    tx?: TransactionClient,
  ): Promise<Prisma.BatchPayload> {
    return this.delegate(tx).updateMany({ where, data });
  }
}
