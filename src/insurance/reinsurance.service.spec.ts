import { ReinsuranceService } from './reinsurance.service';
import { PrismaService } from '../prisma.service';
import { AuditService } from './services/audit.service';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

interface MockPrismaService {
  $transaction: jest.Mock;
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
      $transaction: jest.fn(),
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

      const mockTx = {
        reinsuranceContract: {
          create: jest.fn().mockResolvedValue(createdContract),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      const result = await service.createContract('pool-1', new Prisma.Decimal(50000), new Prisma.Decimal(0.02));

      expect(mockTx.reinsuranceContract.create).toHaveBeenCalledWith({
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

      const mockTx = {
        reinsuranceContract: {
          create: jest.fn().mockResolvedValue(createdContract),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      await service.createContract('pool-1', new Prisma.Decimal(100000), new Prisma.Decimal(0.05));

      expect(auditService.logCreate).toHaveBeenCalledWith(
        'ReinsuranceContract',
        'contract-1',
        createdContract,
        undefined,
        undefined,
      );
    });

    it('should pass correct parameters to prisma.reinsuranceContract.create', async () => {
      const createdContract = {
        id: 'c-2',
        poolId: 'p-2',
        coverageLimit: 25000,
        premiumRate: 0.03,
      };

      const mockTx = {
        reinsuranceContract: {
          create: jest.fn().mockResolvedValue(createdContract),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      await service.createContract('p-2', new Prisma.Decimal(25000), new Prisma.Decimal(0.03));

      expect(mockTx.reinsuranceContract.create).toHaveBeenCalledWith({
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
      const mockTx = {
        reinsuranceContract: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(null),
          delete: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

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

      const mockTx = {
        reinsuranceContract: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(contract),
          delete: jest.fn().mockResolvedValue(contract),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      const result = await service.releaseContract('contract-1');

      expect(mockTx.reinsuranceContract.delete).toHaveBeenCalledWith({
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
