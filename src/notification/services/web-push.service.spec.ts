import { Test, TestingModule } from '@nestjs/testing';
import { WebPushService } from './web-push.service';
import { ConfigService } from '@nestjs/config';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

describe('WebPushService', () => {
  let service: WebPushService;
  const webpushMock = jest.requireMock('web-push') as {
    sendNotification: jest.Mock;
    setVapidDetails: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebPushService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'notification.vapid.publicKey') return 'test-public';
              if (key === 'notification.vapid.privateKey') return 'test-private';
              if (key === 'notification.vapid.subjectEmail') return 'admin@test.com';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WebPushService>(WebPushService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('chaos — web-push provider outage', () => {
    const job = {
      data: {
        subscription: { endpoint: 'https://push.example.com/abc', keys: {} },
        payload: { title: 't', body: 'b' },
      },
    };

    it('rethrows non-410 failures so Bull can retry with backoff', async () => {
      webpushMock.sendNotification.mockRejectedValue(
        new Error('push provider down'),
      );

      await expect(service.handlePushJob(job as any)).rejects.toThrow(
        'push provider down',
      );
      // WEB_PUSH_POLICY: 2 attempts per delivery.
      expect(webpushMock.sendNotification).toHaveBeenCalledTimes(2);
    });

    it('skips expired subscriptions (HTTP 410) without retrying', async () => {
      const expired = Object.assign(new Error('subscription gone'), {
        statusCode: 410,
      });
      webpushMock.sendNotification.mockRejectedValue(expired);

      await expect(service.handlePushJob(job as any)).resolves.toBeUndefined();
      expect(webpushMock.sendNotification).toHaveBeenCalledTimes(1);
    });

    it('fails fast once the circuit is open', async () => {
      webpushMock.sendNotification.mockRejectedValue(
        new Error('push provider down'),
      );

      let openError: unknown;
      for (let i = 0; i < 10 && !openError; i++) {
        try {
          await service.handlePushJob({
            ...job,
            data: {
              ...job.data,
              subscription: {
                endpoint: `https://push.example.com/${i}`,
                keys: {},
              },
            },
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
