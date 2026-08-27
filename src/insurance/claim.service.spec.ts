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
import { NotificationService } from '../notification/services/notification.service';
import { NotificationType } from '../notification/enums/notification-type.enum';

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

interface MockNotificationService {
  prepareNotification: jest.Mock;
  dispatchPrepared: jest.Mock;
}

describe('ClaimService', () => {
  let service: ClaimService;
  let claimRepository: MockClaimRepository;
  let prisma: MockPrismaService;
  let pools: MockPoolService;
  let auditService: MockAuditService;
  let reputationService: MockReputationService;
  let notifications: MockNotificationService;

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
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn({})),
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

    notifications = {
      prepareNotification: jest.fn().mockResolvedValue(null),
      dispatchPrepared: jest.fn().mockResolvedValue(undefined),
    };

    service = new ClaimService(
      prisma as unknown as PrismaService,
      pools as unknown as PoolService,
      auditService as unknown as AuditService,
      reputationService as unknown as ReputationService,
      claimRepository as unknown as ClaimRepository,
      notifications as unknown as NotificationService,
    );
    jest.clearAllMocks();
    notifications.prepareNotification.mockResolvedValue(null);
    notifications.dispatchPrepared.mockResolvedValue(undefined);
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
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          insurancePolicy: {
            findUnique: jest.fn().mockResolvedValue({ id: 'policy-1', userId: 'user-1' }),
          },
        }),
      );

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

    it('should throw BadRequestException if the policy does not exist', async () => {
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          insurancePolicy: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        }),
      );

      await expect(service.createClaim('missing', new Prisma.Decimal(50000))).rejects.toThrow(
        BadRequestException,
      );
      expect(claimRepository.createClaim).not.toHaveBeenCalled();
      expect(notifications.prepareNotification).not.toHaveBeenCalled();
    });

    it('persists the notification inside the transaction and dispatches after commit', async () => {
      const createdClaim = { id: 'claim-new', policyId: 'policy-1', claimAmount: new Prisma.Decimal(50000) };
      claimRepository.createClaim.mockResolvedValue(createdClaim);
      notifications.prepareNotification.mockResolvedValue({ email: undefined, push: undefined });

      const order: string[] = [];
      prisma.$transaction.mockImplementation(async (fn: any) => {
        order.push('transaction-start');
        const result = await fn({
          insurancePolicy: {
            findUnique: jest.fn().mockResolvedValue({ id: 'policy-1', userId: 'user-1' }),
          },
        });
        order.push('transaction-commit');
        return result;
      });
      notifications.dispatchPrepared.mockImplementation(async () => {
        order.push('dispatch');
      });

      await service.createClaim('policy-1', new Prisma.Decimal(50000));

      expect(notifications.prepareNotification).toHaveBeenCalledWith(
        'user-1',
        NotificationType.CLAIM_CREATED,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
      expect(order).toEqual(['transaction-start', 'transaction-commit', 'dispatch']);
    });

    it('does not depend on EncryptionService for the claim amount', () => {
      expect((service as any)['encryption']).toBeUndefined();
    });
  });

  describe('assessClaim', () => {
    it('should throw NotFoundException if claim does not exist', async () => {
      claimRepository.findByIdWithPolicy.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

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
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

      const result = await service.assessClaim('claim-1');

      expect(result.status).toBe(ClaimStatus.REJECTED);
      expect(claimRepository.updateStatusWithPolicy).toHaveBeenCalledWith(
        'claim-1',
        ClaimStatus.REJECTED,
        {},
        expect.any(Object),
      );
      expect(pools.unlockCapital).toHaveBeenCalledWith(
        'pool-1',
        new Prisma.Decimal(50000),
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
      expect(notifications.prepareNotification).toHaveBeenCalledWith(
        'user-1',
        NotificationType.CLAIM_REJECTED,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
      expect(notifications.dispatchPrepared).toHaveBeenCalledWith([]);
    });

    it('should reject claim if claim amount exceeds coverage', async () => {
      const claim = { ...mockClaim, claimAmount: new Prisma.Decimal(200000) };
      const rejectedClaim = { ...claim, status: ClaimStatus.REJECTED };
      claimRepository.findByIdWithPolicy.mockResolvedValue(claim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(rejectedClaim);
      claimRepository.countDuplicates.mockResolvedValue(0);
      claimRepository.countRecent.mockResolvedValue(0);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

      const result = await service.assessClaim('claim-1');

      expect(result.status).toBe(ClaimStatus.REJECTED);
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
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

      const result = await service.assessClaim('claim-1');

      expect(result.status).toBe(ClaimStatus.APPROVED);
      expect(claimRepository.findByIdWithPolicy).toHaveBeenCalledTimes(1);
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
      expect(notifications.prepareNotification).toHaveBeenCalledWith(
        'user-1',
        NotificationType.CLAIM_APPROVED,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
      expect(notifications.dispatchPrepared).toHaveBeenCalledWith([]);
    });

    it('should reject claim if oracle verification fails without a second claim lookup', async () => {
      const expiredPolicy = { ...mockPolicy, endDate: new Date('2020-01-01') };
      const claim = { ...mockClaim, policy: expiredPolicy };
      const rejectedClaim = { ...claim, status: ClaimStatus.REJECTED };

      claimRepository.findByIdWithPolicy.mockResolvedValue(claim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(rejectedClaim);
      claimRepository.countDuplicates.mockResolvedValue(0);
      claimRepository.countRecent.mockResolvedValue(0);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

      const result = await service.assessClaim('claim-1');

      expect(result.status).toBe(ClaimStatus.REJECTED);
      expect(claimRepository.findByIdWithPolicy).toHaveBeenCalledTimes(1);
      expect(auditService.logReject).toHaveBeenCalledWith(
        'Claim',
        'claim-1',
        expect.any(Object),
        rejectedClaim,
        'Oracle verification failed',
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
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

      await service.assessClaim('claim-1');

      expect(claimRepository.findByIdWithPolicy).toHaveBeenCalledTimes(1);
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
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

      await expect(service.payClaim('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should update claim status to PAID', async () => {
      const paidClaim = { ...mockClaim, status: ClaimStatus.PAID };

      claimRepository.findByIdWithPolicy.mockResolvedValue(mockClaim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(paidClaim);
      pools.unlockCapital.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

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
      prisma.$transaction.mockImplementation(async (fn: any) => fn({}));

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

    it('persists the payout notification inside the transaction and dispatches after commit', async () => {
      const paidClaim = { ...mockClaim, status: ClaimStatus.PAID };

      claimRepository.findByIdWithPolicy.mockResolvedValue(mockClaim);
      claimRepository.updateStatusWithPolicy.mockResolvedValue(paidClaim);
      pools.unlockCapital.mockResolvedValue(undefined);
      notifications.prepareNotification.mockResolvedValue({ email: undefined, push: undefined });

      const order: string[] = [];
      prisma.$transaction.mockImplementation(async (fn: any) => {
        order.push('transaction-start');
        const result = await fn({});
        order.push('transaction-commit');
        return result;
      });
      notifications.dispatchPrepared.mockImplementation(async () => {
        order.push('dispatch');
      });

      await service.payClaim('claim-1');

      expect(notifications.prepareNotification).toHaveBeenCalledWith(
        'user-1',
        NotificationType.CLAIM_PAID,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
      expect(order).toEqual(['transaction-start', 'transaction-commit', 'dispatch']);
    });
  });
});
