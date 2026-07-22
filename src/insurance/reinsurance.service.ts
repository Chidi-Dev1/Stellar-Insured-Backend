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
