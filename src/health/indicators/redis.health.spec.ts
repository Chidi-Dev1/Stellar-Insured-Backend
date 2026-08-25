import { Test, TestingModule } from '@nestjs/testing';
import { RedisHealthIndicator } from './redis.health';
import { ConfigService } from '@nestjs/config';
import * as redis from 'redis';
import { HealthCheckError } from '@nestjs/terminus';

jest.mock('redis');

describe('RedisHealthIndicator', () => {
  let indicator: RedisHealthIndicator;
  let configService: ConfigService;
  let mockRedisClient: any;

  beforeEach(async () => {
    mockRedisClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    (redis.createClient as jest.Mock).mockReturnValue(mockRedisClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisHealthIndicator,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'REDIS_URL') {
                return 'redis://localhost:6379';
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    indicator = module.get<RedisHealthIndicator>(RedisHealthIndicator);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isHealthy', () => {
    it('should return healthy status when Redis PING succeeds', async () => {
      mockRedisClient.ping.mockResolvedValue('PONG');

      const result = await indicator.isHealthy('redis');

      expect(result).toHaveProperty('redis');
      expect(result.redis).toHaveProperty('status', 'up');
      expect(result.redis.type).toBe('redis');
      expect(result.redis.message).toBe('Redis PING successful');
    });

    it('should throw HealthCheckError when Redis PING fails', async () => {
      const error = new Error('Connection refused');
      mockRedisClient.ping.mockRejectedValue(error);

      await expect(indicator.isHealthy('redis')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should throw HealthCheckError when unexpected PING response is received', async () => {
      mockRedisClient.ping.mockResolvedValue('UNEXPECTED');

      await expect(indicator.isHealthy('redis')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should throw HealthCheckError when Redis client connection fails', async () => {
      const error = new Error('Connection timeout');
      mockRedisClient.connect.mockRejectedValue(error);

      await expect(indicator.isHealthy('redis')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('should use REDIS_URL from config', async () => {
      mockRedisClient.ping.mockResolvedValue('PONG');

      await indicator.isHealthy('redis');

      expect(configService.get).toHaveBeenCalledWith(
        'REDIS_URL',
        'redis://localhost:6379',
      );
    });
  });
});
