import { Prisma } from '@prisma/client';
import { NotificationService } from './notification.service';
import { EmailService } from './email.service';
import { WebPushService } from './web-push.service';
import { UserService } from '../../user/user.service';
import { NotificationRepository } from '../../common/repositories/notification.repository';
import { NotificationType } from '../enums/notification-type.enum';
import { EmailJobData, PushJobData } from '../constants/queue.constants';
import { Queue } from 'bull';

interface MockRepository {
  createNotification: jest.Mock;
}

interface MockSettingRepository {
  upsertForUser: jest.Mock;
}

interface MockOutboxRepository {
  createOutbox: jest.Mock;
}

interface MockUserService {
  getDecryptedContact: jest.Mock;
}

interface MockEmailService {
  sendEmail: jest.Mock;
}

interface MockWebPushService {
  sendNotification: jest.Mock;
}

interface MockQueue {
  add: jest.Mock;
}

describe('NotificationService', () => {
  let service: NotificationService;
  let notificationRepository: MockRepository;
  let settingRepository: MockSettingRepository;
  let outboxRepository: MockOutboxRepository;
  let emailService: MockEmailService;
  let webPushService: MockWebPushService;
  let userService: MockUserService;
  let emailQueue: MockQueue;
  let pushQueue: MockQueue;

  const contactData = {
    email: 'person@example.com',
    pushSubscription: {
      endpoint: 'https://push.example.test/subscription',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    },
    notificationSettings: {
      emailEnabled: true,
      pushEnabled: true,
      notifyContributions: true,
      notifyMilestones: true,
      notifyDeadlines: true,
    },
  };

  beforeEach(() => {
    notificationRepository = { createNotification: jest.fn() };
    settingRepository = { upsertForUser: jest.fn() };
    outboxRepository = { createOutbox: jest.fn() };
    emailService = { sendEmail: jest.fn() };
    webPushService = { sendNotification: jest.fn() };
    userService = { getDecryptedContact: jest.fn() };
    emailQueue = { add: jest.fn() };
    pushQueue = { add: jest.fn() };

    service = new NotificationService(
      notificationRepository as unknown as NotificationRepository,
      settingRepository as unknown as any,
      outboxRepository as unknown as any,
      emailService as unknown as EmailService,
      webPushService as unknown as WebPushService,
      userService as unknown as UserService,
      emailQueue as unknown as Queue<EmailJobData>,
      pushQueue as unknown as Queue<PushJobData>,
    );

    userService.getDecryptedContact.mockResolvedValue(contactData);
    outboxRepository.createOutbox.mockResolvedValue({
      id: 'outbox-1',
      to: 'person@example.com',
      subject: 'Contribution received',
      html: '<p>A contribution was received.</p>',
    });
  });

  it('persists the notification and outbox row, then enqueues jobs (no inline send)', async () => {
    const data: Prisma.InputJsonObject = { policyId: 'policy-1' };

    await service.notify(
      'user-1',
      NotificationType.CONTRIBUTION,
      'Contribution received',
      'A contribution was received.',
      data,
    );

    expect(notificationRepository.createNotification).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        type: NotificationType.CONTRIBUTION,
        title: 'Contribution received',
        message: 'A contribution was received.',
        data,
      },
      undefined,
    );
    expect(outboxRepository.createOutbox).toHaveBeenCalledWith(
      {
        to: 'person@example.com',
        subject: 'Contribution received',
        html: '<p>A contribution was received.</p>',
        status: 'PENDING',
      },
      undefined,
    );
    // No inline provider call.
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(webPushService.sendNotification).not.toHaveBeenCalled();
    expect(emailQueue.add).toHaveBeenCalledTimes(1);
    expect(emailQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: 'outbox-1' }),
      expect.objectContaining({ attempts: 5 }),
    );
    expect(pushQueue.add).toHaveBeenCalledWith(
      {
        subscription: contactData.pushSubscription,
        payload: {
          title: 'Contribution received',
          body: 'A contribution was received.',
          data,
        },
      },
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it('prepareNotification writes rows through the tx but enqueues nothing', async () => {
    const tx = { id: 'tx-client' } as any;

    const prepared = await service.prepareNotification(
      'user-1',
      NotificationType.CLAIM_CREATED,
      'Claim Submitted',
      'Your claim was submitted.',
      { claimId: 'claim-1' },
      tx,
    );

    // DB rows written with the transaction client…
    expect(notificationRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.CLAIM_CREATED }),
      tx,
    );
    expect(outboxRepository.createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'person@example.com' }),
      tx,
    );
    // …and no queue jobs yet.
    expect(emailQueue.add).not.toHaveBeenCalled();
    expect(pushQueue.add).not.toHaveBeenCalled();

    // dispatchPrepared (post-commit) enqueues only, without touching the DB.
    await service.dispatchPrepared(prepared);

    expect(emailQueue.add).toHaveBeenCalledTimes(1);
    expect(pushQueue.add).toHaveBeenCalledTimes(1);
    expect(notificationRepository.createNotification).toHaveBeenCalledTimes(1);
    expect(outboxRepository.createOutbox).toHaveBeenCalledTimes(1);
  });

  it('dispatchPrepared accepts an array (one dispatch per prepared item)', async () => {
    const prepared = await service.prepareNotification(
      'user-1',
      NotificationType.SYSTEM,
      'One',
      'First',
      undefined,
      undefined,
    );
    const prepared2 = await service.prepareNotification(
      'user-1',
      NotificationType.SYSTEM,
      'Two',
      'Second',
      undefined,
      undefined,
    );

    await service.dispatchPrepared([prepared, prepared2]);

    expect(emailQueue.add).toHaveBeenCalledTimes(2);
    expect(pushQueue.add).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for null/undefined prepared notifications', async () => {
    await service.dispatchPrepared(null);
    await service.dispatchPrepared(undefined);

    expect(emailQueue.add).not.toHaveBeenCalled();
    expect(pushQueue.add).not.toHaveBeenCalled();
  });

  it('honours settings opt-outs and skips persistence entirely', async () => {
    userService.getDecryptedContact.mockResolvedValue({
      ...contactData,
      notificationSettings: {
        ...contactData.notificationSettings,
        notifyContributions: false,
      },
    });

    await service.notify(
      'user-1',
      NotificationType.CONTRIBUTION,
      'Contribution received',
      'Ignored.',
    );

    expect(notificationRepository.createNotification).not.toHaveBeenCalled();
    expect(outboxRepository.createOutbox).not.toHaveBeenCalled();
    expect(emailQueue.add).not.toHaveBeenCalled();
    expect(pushQueue.add).not.toHaveBeenCalled();
  });

  it('returns null when the user cannot be resolved', async () => {
    userService.getDecryptedContact.mockRejectedValue(new Error('not found'));

    const prepared = await service.prepareNotification(
      'user-1',
      NotificationType.SYSTEM,
      'T',
      'M',
      undefined,
      undefined,
    );

    expect(prepared).toBeNull();
    expect(notificationRepository.createNotification).not.toHaveBeenCalled();
  });

  it('a queue failure during dispatch never throws', async () => {
    emailQueue.add.mockRejectedValue(new Error('redis down'));
    const prepared = await service.prepareNotification(
      'user-1',
      NotificationType.SYSTEM,
      'T',
      'M',
      undefined,
      undefined,
    );

    await expect(service.dispatchPrepared(prepared)).resolves.toBeUndefined();
    // The push channel is still dispatched even when the email channel fails.
    expect(pushQueue.add).toHaveBeenCalledTimes(1);
  });
});
