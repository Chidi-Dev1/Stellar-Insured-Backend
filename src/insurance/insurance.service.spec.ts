import { InsuranceService } from './insurance.service';
import { PricingService } from './pricing.service';
import { PoolService } from './pool.service';
import { RiskType } from './enums/risk-type.enum';
import { PolicyStatus } from './enums/policy-status.enum';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EncryptionService } from '../encryption/encryption.service';
import { AuditService } from './services/audit.service';
import { Prisma } from '@prisma/client';

interface MockTransactionClient {
  insurancePolicy: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  insurancePool: { findUnique: jest.Mock; update: jest.Mock };
}

interface MockPrismaService {
  $transaction: jest.Mock;
  insurancePolicy: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
}

describe('InsuranceService', () => {
  let service: InsuranceService;
  let pricing: PricingService;
  let pools: PoolService;
  let prisma: MockPrismaService;
  let encryption: Pick<EncryptionService, 'encrypt'>;
  let auditService: Pick<AuditService, 'log'>;

  const buildMockTx = (createdPolicy: any = { id: 'policy-1' }) => ({
    insurancePolicy: { create: jest.fn().mockResolvedValue(createdPolicy), findUnique: jest.fn(), update: jest.fn() },
    insurancePool: { findUnique: jest.fn(), update: jest.fn() },
  });

  beforeEach(() => {
    pricing = {
      calculatePremium: jest.fn(),
    } as unknown as PricingService;
    pools = {
      lockCapital: jest.fn(),
      unlockCapital: jest.fn(),
    } as unknown as PoolService;

    const mockTx = buildMockTx();

    prisma = {
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(mockTx)),
      insurancePolicy: {
        create: jest.fn().mockResolvedValue({ id: 'policy-1' }),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    encryption = {
      encrypt: jest.fn((val: string) => `enc:${val}`),
    };

    auditService = {
      log: jest.fn(),
      logUpdate: jest.fn(),
    };

    service = new InsuranceService(
      pricing,
      pools,
      prisma as unknown as PrismaService,
      auditService as AuditService,
    );
    jest.clearAllMocks();
  });

  describe('purchasePolicy', () => {
    it('should throw BadRequestException if userId is missing', async () => {
      await expect(
        service.purchasePolicy('', 'pool-1', RiskType.PROJECT_FAILURE, new Prisma.Decimal(1000)),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if poolId is missing', async () => {
      await expect(
        service.purchasePolicy('user-1', '', RiskType.PROJECT_FAILURE, new Prisma.Decimal(1000)),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if coverageAmount is not positive', async () => {
      await expect(
        service.purchasePolicy('user-1', 'pool-1', RiskType.PROJECT_FAILURE, new Prisma.Decimal(0)),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.purchasePolicy(
          'user-1',
          'pool-1',
          RiskType.PROJECT_FAILURE,
          new Prisma.Decimal(-100),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should successfully purchase a policy', async () => {
      (pricing.calculatePremium as jest.Mock).mockReturnValue(new Prisma.Decimal(500));
      (pools.lockCapital as jest.Mock).mockResolvedValue(undefined);

      const mockTx = buildMockTx({ id: 'policy-1', userId: 'user-1', poolId: 'pool-1' });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      const result = await service.purchasePolicy('user-1', 'pool-1', RiskType.PROJECT_FAILURE, new Prisma.Decimal(10000));

      expect(pricing.calculatePremium).toHaveBeenCalledWith(RiskType.PROJECT_FAILURE, new Prisma.Decimal(10000));
      expect(pools.lockCapital).toHaveBeenCalledWith('pool-1', new Prisma.Decimal(10000), mockTx);
      expect(mockTx.insurancePolicy.create).toHaveBeenCalled();
      expect(result.id).toBe('policy-1');
    });

    it('should rollback transaction on error', async () => {
      (pricing.calculatePremium as jest.Mock).mockReturnValue(new Prisma.Decimal(500));
      (pools.lockCapital as jest.Mock).mockRejectedValue(
        new Error('Pool capital insufficient'),
      );

      prisma.$transaction.mockImplementation(async (fn: any) => fn(buildMockTx()));

      await expect(
        service.purchasePolicy(
          'user-1',
          'pool-1',
          RiskType.PROJECT_FAILURE,
          new Prisma.Decimal(10000),
        ),
      ).rejects.toThrow('Pool capital insufficient');
    });

    describe('valid DB payload (issue #399 regression)', () => {
      it('writes plain, unencrypted decimal values for coverageAmount and premium', async () => {
        (pricing.calculatePremium as jest.Mock).mockReturnValue(new Prisma.Decimal(500));
        (pools.lockCapital as jest.Mock).mockResolvedValue(undefined);

        const mockTx = buildMockTx({ id: 'policy-1' });
        prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

        await service.purchasePolicy('user-1', 'pool-1', RiskType.PROJECT_FAILURE, new Prisma.Decimal(10000));

        expect(mockTx.insurancePolicy.create).toHaveBeenCalledWith({
          data: {
            userId: 'user-1',
            poolId: 'pool-1',
            riskType: RiskType.PROJECT_FAILURE,
            coverageAmount: new Prisma.Decimal(10000),
            premium: new Prisma.Decimal(500),
          },
        });
      });

      it('never produces NaN or non-finite values for coverageAmount/premium', async () => {
        (pricing.calculatePremium as jest.Mock).mockReturnValue(new Prisma.Decimal(123.45));
        (pools.lockCapital as jest.Mock).mockResolvedValue(undefined);

        const mockTx = buildMockTx({ id: 'policy-1' });
        prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

        await service.purchasePolicy('user-1', 'pool-1', RiskType.SMART_CONTRACT_EXPLOIT, new Prisma.Decimal(9999.99));

        const writtenData = mockTx.insurancePolicy.create.mock.calls[0][0].data;
        expect(writtenData.coverageAmount).toEqual(new Prisma.Decimal(9999.99));
        expect(writtenData.premium).toEqual(new Prisma.Decimal(123.45));
      });

      it('does not depend on EncryptionService for numeric fields', () => {
        expect(service['encryption']).toBeUndefined();
      });
    });
  });

  describe('cancelPolicy', () => {
    it('should throw BadRequestException if policy not found', async () => {
      const mockTx: MockTransactionClient = {
        insurancePolicy: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
        insurancePool: { findUnique: jest.fn(), update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      await expect(service.cancelPolicy('missing')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if policy already cancelled', async () => {
      const mockTx: MockTransactionClient = {
        insurancePolicy: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue({
            id: 'policy-1',
            status: PolicyStatus.CANCELLED,
            poolId: 'pool-1',
            coverageAmount: 10000,
          }),
          update: jest.fn(),
        },
        insurancePool: { findUnique: jest.fn(), update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      await expect(service.cancelPolicy('policy-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should cancel policy and unlock capital', async () => {
      const policy = {
        id: 'policy-1',
        status: PolicyStatus.ACTIVE,
        poolId: 'pool-1',
        coverageAmount: 10000,
      };
      const cancelled = { ...policy, status: PolicyStatus.CANCELLED };

      const mockTx: MockTransactionClient = {
        insurancePolicy: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(policy),
          update: jest.fn().mockResolvedValue(cancelled),
        },
        insurancePool: { findUnique: jest.fn(), update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
      (pools.unlockCapital as jest.Mock).mockResolvedValue(undefined);

      const result = await service.cancelPolicy('policy-1');

      expect(result.status).toBe(PolicyStatus.CANCELLED);
      expect(pools.unlockCapital).toHaveBeenCalledWith('pool-1', new Prisma.Decimal(10000), mockTx);
    });
  });

  describe('expirePolicy', () => {
    it('should throw BadRequestException if policy not found', async () => {
      const mockTx: MockTransactionClient = {
        insurancePolicy: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
        insurancePool: { findUnique: jest.fn(), update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      await expect(service.expirePolicy('missing')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if policy already expired', async () => {
      const mockTx: MockTransactionClient = {
        insurancePolicy: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue({
            id: 'policy-1',
            status: PolicyStatus.EXPIRED,
            poolId: 'pool-1',
            coverageAmount: 10000,
          }),
          update: jest.fn(),
        },
        insurancePool: { findUnique: jest.fn(), update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

      await expect(service.expirePolicy('policy-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should expire policy and unlock capital', async () => {
      const policy = {
        id: 'policy-1',
        status: PolicyStatus.ACTIVE,
        poolId: 'pool-1',
        coverageAmount: 10000,
      };
      const expired = { ...policy, status: PolicyStatus.EXPIRED };

      const mockTx: MockTransactionClient = {
        insurancePolicy: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(policy),
          update: jest.fn().mockResolvedValue(expired),
        },
        insurancePool: { findUnique: jest.fn(), update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
      (pools.unlockCapital as jest.Mock).mockResolvedValue(undefined);

      const result = await service.expirePolicy('policy-1');

      expect(result.status).toBe(PolicyStatus.EXPIRED);
      expect(pools.unlockCapital).toHaveBeenCalledWith('pool-1', new Prisma.Decimal(10000), mockTx);
    });
  });
});
