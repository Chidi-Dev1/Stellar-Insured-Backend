import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from './services/audit.service';

@Injectable()
export class PoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async addCapital(poolId: string, amount: Prisma.Decimal, tx?: Prisma.TransactionClient) {
    if (amount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Amount must be positive');
    }
    const client = tx ?? this.prisma;
    const pool = await client.insurancePool.findUnique({ where: { id: poolId } });
    if (!pool) {
      throw new NotFoundException(`Pool ${poolId} not found`);
    }
    const beforeState = { ...pool };
    const updatedPool = await client.insurancePool.update({
      where: { id: poolId },
      data: { capital: { increment: amount } },
    });
    await this.auditService.logAddCapital('InsurancePool', poolId, beforeState, updatedPool, undefined, undefined, tx);
    return updatedPool;
  }

  async lockCapital(poolId: string, amount: Prisma.Decimal, tx?: Prisma.TransactionClient) {
    if (amount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Amount must be positive');
    }
    const client = tx ?? this.prisma;
    const pool = await client.insurancePool.findUnique({ where: { id: poolId } });
    if (!pool) {
      throw new NotFoundException(`Pool ${poolId} not found`);
    }
    const beforeState = { ...pool };
    const updatedPool = await client.insurancePool.update({
      where: { id: poolId },
      data: { lockedCapital: { increment: amount } },
    });
    await this.auditService.logUpdate('InsurancePool', poolId, beforeState, updatedPool, undefined, undefined, tx);
    return updatedPool;
  }

  async unlockCapital(poolId: string, amount: Prisma.Decimal, tx?: Prisma.TransactionClient) {
    if (amount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Amount must be positive');
    }
    const client = tx ?? this.prisma;
    const pool = await client.insurancePool.findUnique({ where: { id: poolId } });
    if (!pool) {
      throw new NotFoundException(`Pool ${poolId} not found`);
    }
    const beforeState = { ...pool };
    const updatedPool = await client.insurancePool.update({
      where: { id: poolId },
      data: { lockedCapital: { decrement: amount } },
    });
    const availableCapital = new Prisma.Decimal(updatedPool.capital).minus(
      new Prisma.Decimal(updatedPool.lockedCapital),
    );
    if (availableCapital.lt(new Prisma.Decimal(0))) {
      throw new BadRequestException(
        'Unlocking capital would violate availableCapital invariant',
      );
    }
    await this.auditService.logUnlockCapital(
      'InsurancePool',
      poolId,
      beforeState,
      updatedPool,
      undefined,
      undefined,
      tx,
    );
    return updatedPool;
  }
}
