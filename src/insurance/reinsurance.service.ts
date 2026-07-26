import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from './services/audit.service';

@Injectable()
export class ReinsuranceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createContract(poolId: string, coverageLimit: Prisma.Decimal, premiumRate: Prisma.Decimal) {
    const savedContract = await this.prisma.$transaction(async tx => {
      const contract = await tx.reinsuranceContract.create({
        data: { poolId, coverageLimit, premiumRate },
      });
      await this.auditService.logCreate('ReinsuranceContract', contract.id, contract, undefined, undefined, tx);
      return contract;
    });
    return savedContract;
  }

  async releaseContract(contractId: string) {
    const contract = await this.prisma.$transaction(async tx => {
      const existing = await tx.reinsuranceContract.findUnique({
        where: { id: contractId },
      });
      if (!existing) {
        throw new BadRequestException(`Reinsurance contract ${contractId} not found`);
      }
      // If contract is already released (deleted), check if it's already been processed (idempotent operation)
      // Since we're using soft delete, if deletedAt is not null, the contract is already released
      if (existing.deletedAt) {
        return existing;
      }
      const beforeState = { ...existing };
      const released = await tx.reinsuranceContract.delete({
        where: { id: contractId },
      });
      await this.auditService.logDelete(
        'ReinsuranceContract',
        contractId,
        beforeState,
        undefined,
        'Reinsurance contract released',
        tx,
      );
      return released;
    });
    return contract;
  }
}