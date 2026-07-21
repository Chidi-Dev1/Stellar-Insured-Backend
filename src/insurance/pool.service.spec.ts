import { PoolService } from './pool.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from './services/audit.service';
import { Prisma } from '@prisma/client';

interface MockPrismaService {
  insurancePool: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
}

interface MockAuditService {
  logAddCapital: jest.Mock;
  logUpdate: jest.Mock;
  logUnlockCapital: jest.Mock;
}

describe('PoolService', () => {
  let service: PoolService;
  let prisma: MockPrismaService;
  let auditService: MockAuditService;

  const mockPool = {
    id: 'pool-1',
    name: 'Test Pool',
    capital: 10000,
    lockedCapital: 2000,
    createdAt: new Date(),
  };

  beforeEach(() => {
    prisma = {
      insurancePool: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    auditService = {
      logAddCapital: jest.fn(),
      logUpdate: jest.fn(),
      logUnlockCapital: jest.fn(),
    };

    service = new PoolService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
    jest.clearAllMocks();
  });

  describe('addCapital', () => {
    it('should throw BadRequestException if amount is not positive', async () => {
      await expect(service.addCapital('pool-1', new Prisma.Decimal(0))).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.addCapital('pool-1', new Prisma.Decimal(-100))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if pool is not found', async () => {
      prisma.insurancePool.findUnique.mockResolvedValue(null);

      await expect(service.addCapital('nonexistent', new Prisma.Decimal(500))).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.insurancePool.findUnique).toHaveBeenCalledWith({
        where: { id: 'nonexistent' },
      });
    });

    it('should add capital to an existing pool', async () => {
      const pool = { ...mockPool };
      const updatedPool = { ...pool, capital: 15000 };
      prisma.insurancePool.findUnique.mockResolvedValue(pool);
      prisma.insurancePool.update.mockResolvedValue(updatedPool);

      const result = await service.addCapital('pool-1', new Prisma.Decimal(5000));

      expect(prisma.insurancePool.update).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
        data: { capital: { increment: new Prisma.Decimal(5000) } },
      });
      expect(result.capital).toBe(15000);
    });

    it('should call auditService.logAddCapital after adding capital', async () => {
      const pool = { ...mockPool };
      prisma.insurancePool.findUnique.mockResolvedValue(pool);
      prisma.insurancePool.update.mockResolvedValue({
        ...pool,
        capital: 15000,
      });

      await service.addCapital('pool-1', new Prisma.Decimal(5000));

      expect(auditService.logAddCapital).toHaveBeenCalledWith(
        'InsurancePool',
        'pool-1',
        expect.any(Object),
        expect.any(Object),
        undefined,
        undefined,
      );
    });
  });

  describe('lockCapital', () => {
    it('should throw BadRequestException if amount is not positive', async () => {
      await expect(service.lockCapital('pool-1', new Prisma.Decimal(0))).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.lockCapital('pool-1', new Prisma.Decimal(-50))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if pool is not found (without tx)', async () => {
      prisma.insurancePool.findUnique.mockResolvedValue(null);

      await expect(service.lockCapital('nonexistent', new Prisma.Decimal(1000))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should lock capital without tx using default prisma client', async () => {
      const pool = { ...mockPool };
      const updatedPool = { ...pool, lockedCapital: 3000 };
      prisma.insurancePool.findUnique.mockResolvedValue(pool);
      prisma.insurancePool.update.mockResolvedValue(updatedPool);

      const result = await service.lockCapital('pool-1', new Prisma.Decimal(1000));

      expect(prisma.insurancePool.update).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
        data: { lockedCapital: { increment: new Prisma.Decimal(1000) } },
      });
      expect(result.lockedCapital).toBe(3000);
    });

    it('should lock capital using the provided transaction client', async () => {
      const pool = { ...mockPool };
      const updatedPool = { ...pool, lockedCapital: 5000 };

      const mockTx: MockPrismaService = {
        insurancePool: {
          findUnique: jest.fn().mockResolvedValue(pool),
          update: jest.fn().mockResolvedValue(updatedPool),
        },
      };

      await service.lockCapital(
        'pool-1',
        new Prisma.Decimal(3000),
        mockTx as unknown as PrismaService,
      );

      expect(mockTx.insurancePool.findUnique).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
      });
      expect(mockTx.insurancePool.update).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
        data: { lockedCapital: { increment: new Prisma.Decimal(3000) } },
      });
    });
  });

  describe('unlockCapital', () => {
    it('should throw BadRequestException if amount is not positive', async () => {
      await expect(service.unlockCapital('pool-1', new Prisma.Decimal(0))).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.unlockCapital('pool-1', new Prisma.Decimal(-50))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if pool is not found (without tx)', async () => {
      prisma.insurancePool.findUnique.mockResolvedValue(null);

      await expect(service.unlockCapital('nonexistent', new Prisma.Decimal(1000))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should unlock capital without tx using default prisma client', async () => {
      const pool = { ...mockPool };
      const updatedPool = { ...pool, lockedCapital: 1000 };
      prisma.insurancePool.findUnique.mockResolvedValue(pool);
      prisma.insurancePool.update.mockResolvedValue(updatedPool);

      const result = await service.unlockCapital('pool-1', new Prisma.Decimal(1000));

      expect(prisma.insurancePool.update).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
        data: { lockedCapital: { decrement: new Prisma.Decimal(1000) } },
      });
      expect(result.lockedCapital).toBe(1000);
    });

    it('should unlock capital using the provided transaction client', async () => {
      const pool = { ...mockPool };
      const updatedPool = { ...pool, lockedCapital: 2000 };

      const mockTx: MockPrismaService = {
        insurancePool: {
          findUnique: jest.fn().mockResolvedValue(pool),
          update: jest.fn().mockResolvedValue(updatedPool),
        },
      };

      await service.unlockCapital(
        'pool-1',
        new Prisma.Decimal(1000),
        mockTx as unknown as PrismaService,
      );

      expect(mockTx.insurancePool.findUnique).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
      });
      expect(mockTx.insurancePool.update).toHaveBeenCalledWith({
        where: { id: 'pool-1' },
        data: { lockedCapital: { decrement: new Prisma.Decimal(1000) } },
      });
    });

    it('should enforce availableCapital invariant', async () => {
      const pool = { ...mockPool, capital: 500, lockedCapital: 2000 };
      prisma.insurancePool.findUnique.mockResolvedValue(pool);
      prisma.insurancePool.update.mockResolvedValue({
        ...pool,
        lockedCapital: 1000,
      });

      await expect(service.unlockCapital('pool-1', new Prisma.Decimal(1000))).rejects.toThrow(
        BadRequestException,
      );
      expect(auditService.logUnlockCapital).not.toHaveBeenCalled();
    });

    it('should call auditService.logUnlockCapital after unlocking', async () => {
      const pool = { ...mockPool };
      const updatedPool = { ...pool, lockedCapital: 1000 };
      prisma.insurancePool.findUnique.mockResolvedValue(pool);
      prisma.insurancePool.update.mockResolvedValue(updatedPool);

      await service.unlockCapital('pool-1', new Prisma.Decimal(1000));

      expect(auditService.logUnlockCapital).toHaveBeenCalledWith(
        'InsurancePool',
        'pool-1',
        expect.any(Object),
        expect.any(Object),
        undefined,
        undefined,
      );
    });
  });
});
