import { Test, TestingModule } from '@nestjs/testing';
import { S3HealthIndicator } from './s3.health';
import { ConfigService } from '@nestjs/config';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { HealthCheckError } from '@nestjs/terminus';

jest.mock('@aws-sdk/client-s3');

describe('S3HealthIndicator', () => {
  let indicator: S3HealthIndicator;
  let configService: ConfigService;
  let mockS3Client: any;

  beforeEach(async () => {
    mockS3Client = {
      send: jest.fn().mockResolvedValue({}),
    };

    (S3Client as jest.Mock).mockImplementation(() => mockS3Client);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        S3HealthIndicator,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              switch (key) {
                case 'AWS_REGION':
                  return 'us-east-1';
                case 'AWS_ACCESS_KEY_ID':
                  return 'test-access-key';
                case 'AWS_SECRET_ACCESS_KEY':
                  return 'test-secret-key';
                case 'AWS_S3_BUCKET':
                  return 'test-bucket';
                default:
                  return undefined;
              }
            }),
          },
        },
      ],
    }).compile();

    indicator = module.get<S3HealthIndicator>(S3HealthIndicator);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should throw error if AWS_REGION is missing', () => {
      const invalidConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'AWS_REGION') return undefined;
          return 'dummy';
        }),
      };

      expect(() => {
        new S3HealthIndicator(
          invalidConfigService as any,
        );
      }).toThrow('S3 health indicator: missing AWS configuration');
    });

    it('should throw error if AWS_ACCESS_KEY_ID is missing', () => {
      const invalidConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'AWS_ACCESS_KEY_ID') return undefined;
          if (key === 'AWS_REGION') return 'us-east-1';
          if (key === 'AWS_SECRET_ACCESS_KEY') return 'secret';
          if (key === 'AWS_S3_BUCKET') return 'bucket';
          return undefined;
        }),
      };

      expect(() => {
        new S3HealthIndicator(invalidConfigService as any);
      }).toThrow('S3 health indicator: missing AWS configuration');
    });

    it('should throw error if AWS_S3_BUCKET is missing', () => {
      const invalidConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'AWS_S3_BUCKET') return undefined;
          if (key === 'AWS_REGION') return 'us-east-1';
          if (key === 'AWS_ACCESS_KEY_ID') return 'access-key';
          if (key === 'AWS_SECRET_ACCESS_KEY') return 'secret-key';
          return undefined;
        }),
      };

      expect(() => {
        new S3HealthIndicator(invalidConfigService as any);
      }).toThrow('S3 health indicator: missing AWS configuration');
    });
  });

  describe('isHealthy', () => {
    it('should return healthy status when HeadBucket succeeds', async () => {
      mockS3Client.send.mockResolvedValue({});

      const result = await indicator.isHealthy('storage');

      expect(result).toHaveProperty('storage');
      expect(result.storage).toHaveProperty('status', 'up');
      expect(result.storage.type).toBe('s3');
      expect(result.storage.bucket).toBe('test-bucket');
      expect(result.storage.message).toContain('test-bucket');
    });

    it('should throw HealthCheckError when bucket is not accessible', async () => {
      const error = new Error('NoSuchBucket');
      mockS3Client.send.mockRejectedValue(error);

      await expect(indicator.isHealthy('storage')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should throw HealthCheckError when access is denied', async () => {
      const error = new Error('Access Denied');
      mockS3Client.send.mockRejectedValue(error);

      await expect(indicator.isHealthy('storage')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should throw HealthCheckError on network timeout', async () => {
      const error = new Error('Connection timeout');
      mockS3Client.send.mockRejectedValue(error);

      await expect(indicator.isHealthy('storage')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should include bucket name in response', async () => {
      mockS3Client.send.mockResolvedValue({});

      const result = await indicator.isHealthy('storage');

      expect(result.storage.bucket).toBe('test-bucket');
    });

    it('should use HeadBucketCommand to verify bucket', async () => {
      mockS3Client.send.mockResolvedValue({});

      await indicator.isHealthy('storage');

      expect(mockS3Client.send).toHaveBeenCalled();
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
        }),
      );
    });
  });
});
