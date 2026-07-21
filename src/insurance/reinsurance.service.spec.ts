import { ReinsuranceService } from './reinsurance.service';
import { PrismaService } from '../prisma.service';
import { AuditService } from './services/audit.service';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

interface MockPrismaService {
  reinsuranceContract: {
    create: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
  };
}

interface MockAuditService {
  logCreate: jest.Mock;
  logDelete: jest.Mock;
}

describe('ReinsuranceService', () => {
  let service: ReinsuranceService;
  let prisma: MockPrismaService;
  let auditService: MockAuditService;

  beforeEach(() => {
    prisma = {
      reinsuranceContract: {
        create: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
    };

    auditService = {
      logCreate: jest.fn(),
      logDelete: jest.fn(),
    };

    service = new ReinsuranceService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
    jest.clearAllMocks();
  });

  describe('createContract', () => {
    it('should create and save a reinsurance contract', async () => {
      const contractData = {
        poolId: 'pool-1',
        coverageLimit: 50000,
        premiumRate: 0.02,
      };

      const createdContract = {
        id: 'contract-1',
        ...contractData,
        createdAt: new Date(),
      };
      prisma.reinsuranceContract.create.mockResolvedValue(createdContract);

      const result = await service.createContract('pool-1', new Prisma.Decimal(50000), new Prisma.Decimal(0.02));

      expect(prisma.reinsuranceContract.create).toHaveBeenCalledWith({
        data: {
          poolId: 'pool-1',
          coverageLimit: new Prisma.Decimal(50000),
          premiumRate: new Prisma.Decimal(0.02),
        },
      });
      expect(result).toEqual(createdContract);
    });

    it('should call auditService.logCreate after saving', async () => {
      const createdContract = {
        id: 'contract-1',
        poolId: 'pool-1',
        coverageLimit: 100000,
        premiumRate: 0.05,
        createdAt: new Date(),
      };
      prisma.reinsuranceContract.create.mockResolvedValue(createdContract);

      await service.createContract('pool-1', new Prisma.Decimal(100000), new Prisma.Decimal(0.05));

      expect(auditService.logCreate).toHaveBeenCalledWith(
        'ReinsuranceContract',
        'contract-1',
        createdContract,
      );
    });

    it('should pass correct parameters to prisma.reinsuranceContract.create', async () => {
      const createdContract = {
        id: 'c-2',
        poolId: 'p-2',
        coverageLimit: 25000,
        premiumRate: 0.03,
      };
      prisma.reinsuranceContract.create.mockResolvedValue(createdContract);

      await service.createContract('p-2', new Prisma.Decimal(25000), new Prisma.Decimal(0.03));

      expect(prisma.reinsuranceContract.create).toHaveBeenCalledWith({
        data: {
          poolId: 'p-2',
          coverageLimit: new Prisma.Decimal(25000),
          premiumRate: new Prisma.Decimal(0.03),
        },
      });
    });
  });

  describe('releaseContract', () => {
    it('should throw BadRequestException if contract not found', async () => {
      prisma.reinsuranceContract.findUnique.mockResolvedValue(null);

      await expect(service.releaseContract('missing')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should delete the reinsurance contract and audit the release', async () => {
      const contract = {
        id: 'contract-1',
        poolId: 'pool-1',
        coverageLimit: 50000,
        premiumRate: 0.02,
        createdAt: new Date(),
      };
      prisma.reinsuranceContract.findUnique.mockResolvedValue(contract);
      prisma.reinsuranceContract.delete.mockResolvedValue(contract);

      const result = await service.releaseContract('contract-1');

      expect(prisma.reinsuranceContract.delete).toHaveBeenCalledWith({
        where: { id: 'contract-1' },
      });
      expect(result).toEqual(contract);
      expect(auditService.logDelete).toHaveBeenCalledWith(
        'ReinsuranceContract',
        'contract-1',
        expect.any(Object),
        undefined,
        'Reinsurance contract released',
      );
    });
  });
});
