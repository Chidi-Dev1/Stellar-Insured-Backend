import { EventHandlerService } from './event-handler.service';
import { ContractEventType, ParsedContractEvent } from '../types/event-types';

/**
 * Regression coverage for #478: handlers must go through the injected
 * repositories (UserRepository/ProjectRepository/ContributionRepository/
 * MilestoneRepository), never `this.prisma.*` directly. Every dependency
 * below is a plain repository/service mock — no PrismaService anywhere —
 * so a handler that reached for raw Prisma would fail to compile/run here.
 */
describe('EventHandlerService', () => {
  const userRepository = {
    upsertByWallet: jest.fn(),
  };
  const projectRepository = {
    upsertByContractId: jest.fn(),
    findByContractId: jest.fn(),
    updateById: jest.fn(),
    updateManyByContractId: jest.fn(),
  };
  const contributionRepository = {
    upsertByTxHash: jest.fn(),
    findDistinctInvestors: jest.fn(),
  };
  const milestoneRepository = {
    updateManyByProject: jest.fn(),
  };
  const notificationService = {
    notify: jest.fn(),
  };
  const reputationService = {
    adjustReputation: jest.fn(),
    updateTrustScore: jest.fn(),
  };

  let service: EventHandlerService;

  const baseEvent = {
    eventId: 'evt-1',
    ledgerSeq: 100,
    ledgerClosedAt: new Date('2026-01-01T00:00:00Z'),
    contractId: 'CONTRACT',
    transactionHash: 'tx-hash',
    quarantined: false,
    inSuccessfulContractCall: true,
  };

  function event(
    eventType: ContractEventType,
    data: Record<string, unknown>,
  ): ParsedContractEvent {
    return { ...baseEvent, eventType, data } as ParsedContractEvent;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    contributionRepository.findDistinctInvestors.mockResolvedValue([]);
    service = new EventHandlerService(
      userRepository as any,
      projectRepository as any,
      contributionRepository as any,
      milestoneRepository as any,
      notificationService as any,
      reputationService as any,
    );
  });

  it('registers a handler for every supported event type', () => {
    expect(service.isSupported(ContractEventType.PROJECT_CREATED)).toBe(true);
    expect(service.isSupported(ContractEventType.CONTRIBUTION_MADE)).toBe(true);
    expect(service.isSupported(ContractEventType.MILESTONE_APPROVED)).toBe(true);
    expect(service.isSupported(ContractEventType.MILESTONE_REJECTED)).toBe(true);
    expect(service.isSupported(ContractEventType.FUNDS_RELEASED)).toBe(true);
    expect(service.isSupported(ContractEventType.PROJECT_COMPLETED)).toBe(true);
    expect(service.isSupported(ContractEventType.PROJECT_FAILED)).toBe(true);
    expect(service.isSupported(ContractEventType.DIVIDEND_CLAIMED)).toBe(true);
  });

  describe('PROJECT_CREATED', () => {
    it('upserts the creator and project through the repositories', async () => {
      userRepository.upsertByWallet.mockResolvedValue({ id: 'user-1' });
      projectRepository.upsertByContractId.mockResolvedValue({ id: 'project-1' });

      const ok = await service.processEvent(
        event(ContractEventType.PROJECT_CREATED, {
          projectId: 1,
          creator: 'GCREATOR',
          fundingGoal: '1000',
          deadline: 1700000000,
          token: 'USDC',
        }),
      );

      expect(ok).toBe(true);
      expect(userRepository.upsertByWallet).toHaveBeenCalledWith(
        'GCREATOR',
        expect.objectContaining({ walletAddress: 'GCREATOR' }),
        {},
      );
      expect(projectRepository.upsertByContractId).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ creatorId: 'user-1' }),
        expect.any(Object),
      );
    });

    it('fails validation when required fields are missing', async () => {
      const ok = await service.processEvent(
        event(ContractEventType.PROJECT_CREATED, { projectId: 1 }),
      );

      expect(ok).toBe(false);
      expect(userRepository.upsertByWallet).not.toHaveBeenCalled();
      expect(projectRepository.upsertByContractId).not.toHaveBeenCalled();
    });
  });

  describe('CONTRIBUTION_MADE', () => {
    it('records the contribution and updates project funds when the project exists', async () => {
      userRepository.upsertByWallet.mockResolvedValue({ id: 'user-1' });
      projectRepository.findByContractId.mockResolvedValue({
        id: 'project-1',
        title: 'Test Project',
      });

      const ok = await service.processEvent(
        event(ContractEventType.CONTRIBUTION_MADE, {
          projectId: 1,
          contributor: 'GCONTRIB',
          amount: '500',
          totalRaised: '1500',
        }),
      );

      expect(ok).toBe(true);
      expect(contributionRepository.upsertByTxHash).toHaveBeenCalledWith(
        'tx-hash',
        expect.objectContaining({
          investorId: 'user-1',
          projectId: 'project-1',
          amount: 500n,
        }),
      );
      expect(projectRepository.updateById).toHaveBeenCalledWith('project-1', {
        currentFunds: 1500n,
      });
      expect(notificationService.notify).toHaveBeenCalled();
      expect(reputationService.adjustReputation).toHaveBeenCalled();
    });

    it('skips persistence when the project cannot be found', async () => {
      userRepository.upsertByWallet.mockResolvedValue({ id: 'user-1' });
      projectRepository.findByContractId.mockResolvedValue(null);

      const ok = await service.processEvent(
        event(ContractEventType.CONTRIBUTION_MADE, {
          projectId: 1,
          contributor: 'GCONTRIB',
          amount: '500',
          totalRaised: '1500',
        }),
      );

      expect(ok).toBe(true);
      expect(contributionRepository.upsertByTxHash).not.toHaveBeenCalled();
      expect(projectRepository.updateById).not.toHaveBeenCalled();
    });

    it('does not fail the event when the notification send throws', async () => {
      userRepository.upsertByWallet.mockResolvedValue({ id: 'user-1' });
      projectRepository.findByContractId.mockResolvedValue({
        id: 'project-1',
        title: 'Test Project',
      });
      notificationService.notify.mockRejectedValue(new Error('notify down'));

      const ok = await service.processEvent(
        event(ContractEventType.CONTRIBUTION_MADE, {
          projectId: 1,
          contributor: 'GCONTRIB',
          amount: '500',
          totalRaised: '1500',
        }),
      );

      expect(ok).toBe(true);
      expect(reputationService.adjustReputation).toHaveBeenCalled();
    });
  });

  describe('MILESTONE_APPROVED', () => {
    it('marks milestones approved and notifies investors and the creator', async () => {
      projectRepository.findByContractId.mockResolvedValue({
        id: 'project-1',
        title: 'Test Project',
        creatorId: 'creator-1',
      });
      contributionRepository.findDistinctInvestors.mockResolvedValue([
        { investorId: 'investor-1' },
      ]);

      const ok = await service.processEvent(
        event(ContractEventType.MILESTONE_APPROVED, {
          projectId: 1,
          milestoneId: 1,
        }),
      );

      expect(ok).toBe(true);
      expect(milestoneRepository.updateManyByProject).toHaveBeenCalledWith(
        'project-1',
        { status: 'APPROVED' },
      );
      expect(notificationService.notify).toHaveBeenCalledWith(
        'investor-1',
        expect.anything(),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
      expect(reputationService.updateTrustScore).toHaveBeenCalledWith(
        'creator-1',
      );
      expect(reputationService.adjustReputation).toHaveBeenCalled();
    });

    it('skips processing when the project cannot be found', async () => {
      projectRepository.findByContractId.mockResolvedValue(null);

      const ok = await service.processEvent(
        event(ContractEventType.MILESTONE_APPROVED, {
          projectId: 1,
          milestoneId: 1,
        }),
      );

      expect(ok).toBe(true);
      expect(milestoneRepository.updateManyByProject).not.toHaveBeenCalled();
    });
  });

  describe('MILESTONE_REJECTED', () => {
    it('marks milestones rejected and adjusts creator reputation', async () => {
      projectRepository.findByContractId.mockResolvedValue({
        id: 'project-1',
        title: 'Test Project',
        creatorId: 'creator-1',
      });

      const ok = await service.processEvent(
        event(ContractEventType.MILESTONE_REJECTED, {
          projectId: 1,
          milestoneId: 1,
        }),
      );

      expect(ok).toBe(true);
      expect(milestoneRepository.updateManyByProject).toHaveBeenCalledWith(
        'project-1',
        { status: 'REJECTED' },
      );
      expect(reputationService.updateTrustScore).toHaveBeenCalledWith(
        'creator-1',
      );
    });
  });

  describe('FUNDS_RELEASED', () => {
    it('marks the milestone funded when the project exists', async () => {
      projectRepository.findByContractId.mockResolvedValue({ id: 'project-1' });

      const ok = await service.processEvent(
        event(ContractEventType.FUNDS_RELEASED, {
          projectId: 1,
          milestoneId: 1,
          amount: '1000',
        }),
      );

      expect(ok).toBe(true);
      expect(milestoneRepository.updateManyByProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ status: 'FUNDED' }),
      );
    });

    it('skips processing when the project cannot be found', async () => {
      projectRepository.findByContractId.mockResolvedValue(null);

      const ok = await service.processEvent(
        event(ContractEventType.FUNDS_RELEASED, {
          projectId: 1,
          milestoneId: 1,
          amount: '1000',
        }),
      );

      expect(ok).toBe(true);
      expect(milestoneRepository.updateManyByProject).not.toHaveBeenCalled();
    });
  });

  describe('PROJECT_COMPLETED / PROJECT_FAILED', () => {
    it('updates project status by contract id when completed', async () => {
      const ok = await service.processEvent(
        event(ContractEventType.PROJECT_COMPLETED, { projectId: 1 }),
      );

      expect(ok).toBe(true);
      expect(projectRepository.updateManyByContractId).toHaveBeenCalledWith(
        '1',
        { status: 'COMPLETED' },
      );
    });

    it('updates project status by contract id when failed', async () => {
      const ok = await service.processEvent(
        event(ContractEventType.PROJECT_FAILED, { projectId: 1 }),
      );

      expect(ok).toBe(true);
      expect(projectRepository.updateManyByContractId).toHaveBeenCalledWith(
        '1',
        { status: 'CANCELLED' },
      );
    });
  });

  describe('DIVIDEND_CLAIMED', () => {
    it('upserts the claimer and refreshes their trust score', async () => {
      userRepository.upsertByWallet.mockResolvedValue({ id: 'user-1' });

      const ok = await service.processEvent(
        event(ContractEventType.DIVIDEND_CLAIMED, {
          poolId: 'pool-1',
          claimer: 'GCLAIMER',
          amount: '100',
        }),
      );

      expect(ok).toBe(true);
      expect(userRepository.upsertByWallet).toHaveBeenCalledWith(
        'GCLAIMER',
        expect.objectContaining({ walletAddress: 'GCLAIMER' }),
        {},
      );
      expect(reputationService.updateTrustScore).toHaveBeenCalledWith('user-1');
    });
  });

  describe('unsupported event types', () => {
    it('returns false and touches no repository', async () => {
      const ok = await service.processEvent(
        event(ContractEventType.VOTE_CAST, {}),
      );

      expect(ok).toBe(false);
      expect(userRepository.upsertByWallet).not.toHaveBeenCalled();
      expect(projectRepository.findByContractId).not.toHaveBeenCalled();
    });
  });
});
