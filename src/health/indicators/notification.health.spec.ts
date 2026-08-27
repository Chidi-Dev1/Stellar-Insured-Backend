import { Test, TestingModule } from '@nestjs/testing';
import { NotificationHealthIndicator } from './notification.health';
import { ConfigService } from '@nestjs/config';
import { HealthCheckError } from '@nestjs/terminus';

describe('NotificationHealthIndicator', () => {
  let indicator: NotificationHealthIndicator;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationHealthIndicator,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'notification.sendgrid.apiKey') {
                return 'SG.test-api-key-123456789';
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    indicator = module.get<NotificationHealthIndicator>(
      NotificationHealthIndicator,
    );
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isHealthy', () => {
    it('should return healthy status when SendGrid API key is configured', async () => {
      const result = await indicator.isHealthy('notifications');

      expect(result).toHaveProperty('notifications');
      expect(result.notifications).toHaveProperty('status', 'up');
      expect(result.notifications.type).toBe('sendgrid');
      expect(result.notifications.message).toContain('SendGrid API key');
    });

    it('should throw HealthCheckError when SendGrid API key is not configured', async () => {
      const invalidConfigService = {
        get: jest.fn(() => undefined),
      };

      const invalidIndicator = new NotificationHealthIndicator(
        invalidConfigService as any,
      );

      await expect(invalidIndicator.isHealthy('notifications')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should throw HealthCheckError when SendGrid API key format is invalid', async () => {
      const invalidConfigService = {
        get: jest.fn(() => 'invalid-api-key'),
      };

      const invalidIndicator = new NotificationHealthIndicator(
        invalidConfigService as any,
      );

      await expect(invalidIndicator.isHealthy('notifications')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should validate API key starts with SG.', async () => {
      const result = await indicator.isHealthy('notifications');

      expect(result.notifications.status).toBe('up');
    });

    it('should use notification.sendgrid.apiKey from config', async () => {
      await indicator.isHealthy('notifications');

      expect(configService.get).toHaveBeenCalledWith(
        'notification.sendgrid.apiKey',
      );
    });

    it('should accept valid SendGrid API key formats', async () => {
      const validKeys = [
        'SG.test123456789',
        'SG.abc-def-ghi-jkl',
        'SG.1234567890abcdefghijklmnopqrstuvwxyz',
      ];

      for (const key of validKeys) {
        const validConfigService = {
          get: jest.fn(() => key),
        };

        const testIndicator = new NotificationHealthIndicator(
          validConfigService as any,
        );

        const result = await testIndicator.isHealthy('notifications');
        expect(result.notifications.status).toBe('up');
      }
    });

    it('should reject API keys not starting with SG.', async () => {
      const invalidKeys = [
        'test-api-key',
        'API.test123',
        'sendgrid.test',
        'SG',
        '',
      ];

      for (const key of invalidKeys) {
        const invalidConfigService = {
          get: jest.fn(() => key),
        };

        const testIndicator = new NotificationHealthIndicator(
          invalidConfigService as any,
        );

        await expect(testIndicator.isHealthy('notifications')).rejects.toThrow(
          HealthCheckError,
        );
      }
    });
  });
});
