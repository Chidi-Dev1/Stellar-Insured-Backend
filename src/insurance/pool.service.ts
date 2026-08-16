import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InsurancePoolRepository } from '../common/repositories/insurance-pool.repository';
import { AuditService } from './services/audit.service';
import { TransactionClient } from '../common/repositories/repository.interface';
import { PrismaService } from '../prisma.service';

@Injectable()
export class PoolService {
  constructor(
    private readonly poolRepository: InsurancePoolRepository,
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async addCapital(poolId: string, amount: Prisma.Decimal, tx?: TransactionClient) {
    if (amount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Amount must be positive');
    }

    const execute = async (client: TransactionClient) => {
      const pool = await this.poolRepository.findByIdRequired(poolId, client);
      if (!pool) {
        throw new NotFoundException(`Pool ${poolId} not found`);
      }
      const beforeState = { ...pool };
      const updatedPool = await this.poolRepository.incrementCapital(poolId, amount, client);
      await this.auditService.logAddCapital('InsurancePool', poolId, beforeState, updatedPool, undefined, undefined, client);
      return updatedPool;
    };

    return tx ? execute(tx) : this.prisma.$transaction(execute);
  }

  async lockCapital(poolId: string, amount: Prisma.Decimal, tx?: TransactionClient) {
    if (amount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Amount must be positive');
    }

    const execute = async (client: TransactionClient) => {
      const pool = await this.poolRepository.findByIdRequired(poolId, client);
      if (!pool) {
        throw new NotFoundException(`Pool ${poolId} not found`);
      }
      const beforeState = { ...pool };
      const updatedPool = await this.poolRepository.incrementLockedCapital(poolId, amount, client);
      await this.auditService.logUpdate('InsurancePool', poolId, beforeState, updatedPool, undefined, undefined, client);
      return updatedPool;
    };

    return tx ? execute(tx) : this.prisma.$transaction(execute);
  }

  async unlockCapital(poolId: string, amount: Prisma.Decimal, tx?: TransactionClient) {
    if (amount.lte(new Prisma.Decimal(0))) {
      throw new BadRequestException('Amount must be positive');
    }

    const execute = async (client: TransactionClient) => {
      const pool = await this.poolRepository.findByIdRequired(poolId, client);
      if (!pool) {
        throw new NotFoundException(`Pool ${poolId} not found`);
      }
      const beforeState = { ...pool };
      const updatedPool = await this.poolRepository.decrementLockedCapital(poolId, amount, client);
      const availableCapital = new Prisma.Decimal(updatedPool.capital).minus(
        new Prisma.Decimal(updatedPool.lockedCapital),
      );
      if (availableCapital.lt(new Prisma.Decimal(0))) {
        throw new BadRequestException('Unlocking capital would violate availableCapital invariant');
      }
      await this.auditService.logUnlockCapital('InsurancePool', poolId, beforeState, updatedPool, undefined, undefined, client);
      return updatedPool;
    };

    return tx ? execute(tx) : this.prisma.$transaction(execute);
  }
}
