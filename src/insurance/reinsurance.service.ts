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
    const savedContract = await this.prisma.reinsuranceContract.create({
      data: { poolId, coverageLimit, premiumRate },
    });
    await this.auditService.logCreate('ReinsuranceContract', savedContract.id, savedContract);
    return savedContract;
  }

  async releaseContract(contractId: string) {
    const contract = await this.prisma.reinsuranceContract.findUnique({
      where: { id: contractId },
    });
    if (!contract) {
      throw new BadRequestException(`Reinsurance contract ${contractId} not found`);
    }
    const beforeState = { ...contract };
    const released = await this.prisma.reinsuranceContract.delete({
      where: { id: contractId },
    });
    await this.auditService.logDelete(
      'ReinsuranceContract',
      contractId,
      beforeState,
      undefined,
      'Reinsurance contract released',
    );
    return released;
  }
}
