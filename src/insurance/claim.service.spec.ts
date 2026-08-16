import { ClaimService } from './claim.service';
import { ClaimStatus } from './enums/claim-status.enum';
import { PolicyStatus } from './enums/policy-status.enum';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PoolService } from './pool.service';
import { AuditService } from './services/audit.service';
import { ReputationService } from '../reputation/reputation.service';
import { REPUTATION_DELTAS } from '../reputation/reputation.constants';
import { ClaimRepository } from '../common/repositories/claim.repository';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

interface MockClaimRepository {
  findByIdWithPolicy: jest.Mock;
  createClaim: jest.Mock;
  countDuplicates: jest.Mock;
  countRecent: jest.Mock;
  updateStatusWithPolicy: jest.Mock;
}

interface MockPrismaService {
  $transaction: jest.Mock;
}

interface MockPoolService {
  unlockCapital: jest.Mock;
}

interface MockAuditService {
  log: jest.Mock;
  logCreate: jest.Mock;
  logApprove: jest.Mock;
  logReject: jest.Mock;
  logPayout: jest.Mock;
  logUpdate: jest.Mock;
}

interface MockReputationService {
  adjustReputation: jest.Mock;
}

describe('ClaimService', () => {
  let service: ClaimService;
  let claimRepository: MockClaimRepository;
  let prisma: MockPrismaService;
  let pools: MockPoolService;
  let auditService: MockAuditService;
  let reputationService: MockReputationService;

  const mockPolicy = {
    id: 'policy-1',
    userId: 'user-1',
    poolId: 'pool-1',
    status: PolicyStatus.ACTIVE,
    coverageAmount: new Prisma.Decimal(100000),
    premium: new Prisma.Decimal(5000),
    startDate: new Date('2025-01-01'),
    endDate: new Date('2027-01-01'),
  };

  const mockClaim = {
    id: 'claim-1',
    policyId: 'policy-1',
    claimAmount: new Prisma.Decimal(50000),
    status: ClaimStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    policy: mockPolicy,
  };

  beforeEach(() => {
    claimRepository = {
      findByIdWithPolicy: jest.fn(),
      createClaim: jest.fn(),
      countDuplicates: jest.fn(),
      countRecent: jest.fn(),
      updateStatusWithPolicy: jest.fn(),
    };

    prisma = {
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn()),
    };

    pools = { unlockCapital: jest.fn() };

    auditService = {
      log: jest.fn(),
      logCreate: jest.fn(),
      logApprove: jest.fn(),
      logReject: jest.fn(),
      logPayout: jest.fn(),
      logUpdate: jest.fn(),
    };

    reputationService = { adjustReputation: jest.fn() };

    service = new ClaimService(
      prisma as unknown as PrismaService,
      pools as unknown as PoolService,
      auditService as unknown as AuditService,
      reputationService as unknown as ReputationService,
      claimRepository as unknown as ClaimRepository,
    );
    jest.clearAllMocks();
  });

  describe('createClaim', () => {
    it('should create a claim with the correct data', async () => {
      const createdClaim = {
        id: 'claim-new',
        policyId: 'policy-1',
        claimAmount: new Prisma.Decimal(50000),
        status: ClaimStatus.PENDING,
      };
      claimRepository.createClaim.mockResolvedValue(createdClaim);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      const result = await service.createClaim('policy-1', new Prisma.Decimal(50000));

      expect(claimRepository.createClaim).toHaveBeenCalledWith(
        {
          policyId: 'policy-1',
          claimAmount: new Prisma.Decimal(50000),
          status: ClaimStatus.PENDING,
        },
        expect.any(Object),
      );
      expect(auditService.logCreate).toHaveBeenCalledWith(
        'Claim',
        'claim-new',
        createdClaim,
        undefined,
        undefined,
        expect.any(Object),
      );
      expect(result.claimAmount).toEqual(new Prisma.Decimal(50000));
    });

    it('does not depend on EncryptionService for the claim amount', () => {
      expect((service as any)['encryption']).toBeUndefined();
    });
  });

  describe('assessClaim', () => {
    it('should throw NotFoundException if claim does not exist', async () => {
      claimRepository.findByIdWithPolicy.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      await expect(service.assessClaim('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if policy is not found on claim', async () => {
      claimRepository.findByIdWithPolicy.mockResolvedValue({ ...mockClaim, policy: null });

      await expect(service.assessClaim('claim-1')).rejects.toThrow(NotFoundException);
    });

    it('should reject claim if policy is not active', async () => {
      const inactivePolicy = { ...mockPolicy, status: PolicyStatus.EXPIRED };
      const rejectedClaim = {
        ...mockClaim,
        status: ClaimStatus.REJECTED,
        policy: inactivePolicy,
      };
      claimRepository.findByIdWithPolicy.mockResolvedValue({
        ...mockClaim,
        policy: inactivePolicy,
      });
      claimRepository.updateStatusWithPolicy.mockResolvedValue(rejectedClaim);
      claimRepository.countDuplicates.mockResolvedValue(0);
      claimRepository.countRecent.mockResolvedValue(0);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      await expect(service.assessClaim('claim-1')).rejects.toThrow(BadRequestException);

      expect(claimRepository.updateStatusWithPolicy).toHaveBeenCalledWith(
        'claim-1',
        ClaimStatus.REJECTED,
        {},
        expect.any(Object),
      );
      expect(auditService.logReject).toHaveBeenCalledWith(
        'Claim',
        'claim-1',
        expect.any(Object),
        rejectedClaim,
        'Policy is not active: EXPIRED',
        expect.any(Object),
      );
      expect(reputationService.adjustReputation).toHaveBeenCalledWith(
        'user-1',
        REPUTATION_DELTAS.CLAIM_REJECTED,
        'Claim claim-1 rejected: Policy is not active: EXPIRED',
        expect.any(Object),
      );
    });

    it('should reject claim if claim amount exceeds coverage', async () => {
      const claim = { ...mockClaim, claimAmount: new Prisma.Decimal(200000) };
      const rejectedClaim = { ...claim, status: ClaimStatus.REJECTED };
      claimRepository.findByIdWithPolicy.mockResolvedValue(claim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(rejectedClaim);
      claimRepository.countDuplicates.mockResolvedValue(0);
      claimRepository.countRecent.mockResolvedValue(0);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      await expect(service.assessClaim('claim-1')).rejects.toThrow(BadRequestException);

      expect(auditService.logReject).toHaveBeenCalledWith(
        'Claim',
        'claim-1',
        expect.any(Object),
        rejectedClaim,
        'Claim amount exceeds coverage',
        expect.any(Object),
      );
      expect(reputationService.adjustReputation).toHaveBeenCalledWith(
        'user-1',
        REPUTATION_DELTAS.CLAIM_REJECTED,
        'Claim claim-1 rejected: Claim amount exceeds coverage',
        expect.any(Object),
      );
    });

    it('should approve claim when all checks pass', async () => {
      const approvedClaim = {
        ...mockClaim,
        status: ClaimStatus.APPROVED,
        payoutAmount: new Prisma.Decimal(50000),
      };

      claimRepository.findByIdWithPolicy.mockResolvedValue(mockClaim);
      claimRepository.countDuplicates.mockResolvedValue(0);
      claimRepository.countRecent.mockResolvedValue(0);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(approvedClaim);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      const result = await service.assessClaim('claim-1');

      expect(result.status).toBe(ClaimStatus.APPROVED);
      expect(auditService.logApprove).toHaveBeenCalledWith(
        'Claim',
        'claim-1',
        expect.any(Object),
        approvedClaim,
        undefined,
        undefined,
        expect.any(Object),
      );
      expect(reputationService.adjustReputation).toHaveBeenCalledWith(
        'user-1',
        REPUTATION_DELTAS.CLAIM_APPROVED,
        'Claim claim-1 approved',
        expect.any(Object),
      );
    });

    it('should detect fraud and log when >= 2 indicators present', async () => {
      const claim = {
        ...mockClaim,
        createdAt: new Date('2026-04-27T03:00:00Z'),
      };
      const approvedClaim = {
        ...claim,
        status: ClaimStatus.APPROVED,
        payoutAmount: new Prisma.Decimal(50000),
      };

      claimRepository.findByIdWithPolicy.mockResolvedValue(claim);
      claimRepository.countDuplicates.mockResolvedValue(1);
      claimRepository.countRecent.mockResolvedValue(4);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(approvedClaim);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      await service.assessClaim('claim-1');

      expect(auditService.log).toHaveBeenCalledWith(
        expect.anything(),
        'Claim',
        'claim-1',
        expect.any(Object),
        expect.any(Object),
        undefined,
        'High fraud risk score detected',
        expect.any(Object),
      );
      expect(reputationService.adjustReputation).toHaveBeenCalledWith(
        'user-1',
        REPUTATION_DELTAS.FRAUD_DETECTED,
        'Fraud detected on claim claim-1',
        expect.any(Object),
      );
    });
  });

  describe('payClaim', () => {
    it('should throw NotFoundException if claim does not exist', async () => {
      claimRepository.findByIdWithPolicy.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      await expect(service.payClaim('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should update claim status to PAID', async () => {
      const paidClaim = { ...mockClaim, status: ClaimStatus.PAID };

      claimRepository.findByIdWithPolicy.mockResolvedValue(mockClaim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(paidClaim);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      const result = await service.payClaim('claim-1');

      expect(result.status).toBe(ClaimStatus.PAID);
      expect(pools.unlockCapital).toHaveBeenCalledWith(
        'pool-1',
        new Prisma.Decimal(50000),
        expect.any(Object),
      );
    });

    it('should call auditService.logPayout after paying', async () => {
      const paidClaim = { ...mockClaim, status: ClaimStatus.PAID };

      claimRepository.findByIdWithPolicy.mockResolvedValue(mockClaim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(paidClaim);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn());

      await service.payClaim('claim-1');

      expect(auditService.logPayout).toHaveBeenCalledWith(
        'Claim',
        'claim-1',
        expect.any(Object),
        expect.any(Object),
        undefined,
        undefined,
        expect.any(Object),
      );
    });
  });
});