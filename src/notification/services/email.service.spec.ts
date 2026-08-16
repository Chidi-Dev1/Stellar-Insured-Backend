import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from './email.service';
import { EmailOutboxRepository } from '../../common/repositories/notification.repository';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { QUEUE_NAMES } from '../constants/queue.constants';
import * as sgMail from '@sendgrid/mail';

// Mock @sendgrid/mail so the constructor doesn't throw in unit test context
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

describe('EmailService', () => {
  let service: EmailService;
  const emailOutboxRepository = { updateStatus: jest.fn() };
  const sgMailMock = jest.requireMock('@sendgrid/mail') as {
    send: jest.Mock;
    setApiKey: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: EmailOutboxRepository,
          useValue: emailOutboxRepository,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'notification.sendgrid.apiKey') return 'test-key';
              if (key === 'notification.sendgrid.fromEmail') return 'noreply@test.com';
              return undefined;
            }),
          },
        },
        {
          provide: getQueueToken(QUEUE_NAMES.EMAIL),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('chaos — SendGrid outage', () => {
    const job = {
      data: {
        outboxId: 'outbox-1',
        to: 'user@example.com',
        subject: 'Hi',
        html: '<p>hi</p>',
      },
      attemptsMade: 0,
    };

    it('retries internally, marks the outbox PENDING, and rethrows for Bull backoff', async () => {
      sgMailMock.send.mockRejectedValue(new Error('sendgrid down'));

      await expect(service.handleEmailJob(job as any)).rejects.toThrow(
        'sendgrid down',
      );
      // SENDGRID_POLICY: 2 attempts per delivery.
      expect(sgMailMock.send).toHaveBeenCalledTimes(2);
      expect(emailOutboxRepository.updateStatus).toHaveBeenCalledWith(
        'outbox-1',
        expect.objectContaining({
          attempts: 1,
          status: 'PENDING',
          lastError: 'sendgrid down',
        }),
      );
    });

    it('fails fast once the circuit is open', async () => {
      sgMailMock.send.mockRejectedValue(new Error('sendgrid down'));

      let openError: unknown;
      for (let i = 0; i < 10 && !openError; i++) {
        try {
          await service.handleEmailJob({
            ...job,
            data: { ...job.data, outboxId: `outbox-${i}` },
          } as any);
        } catch (error) {
          if ((error as { code?: string })?.code === 'EOPENBREAKER') {
            openError = error;
          }
        }
      }

      expect(openError).toBeDefined();
    });
  });
});
