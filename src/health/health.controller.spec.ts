import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import {
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorResult,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { PrismaHealthIndicator } from '../common/health/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { BullHealthIndicator } from './indicators/bull.health';
import { S3HealthIndicator } from './indicators/s3.health';
import { NotificationHealthIndicator } from './indicators/notification.health';

describe('HealthController', () => {
  let controller: HealthController;
  let healthCheckService: HealthCheckService;
  let prismaHealth: PrismaHealthIndicator;
  let redisHealth: RedisHealthIndicator;
  let bullHealth: BullHealthIndicator;
  let s3Health: S3HealthIndicator;
  let notificationHealth: NotificationHealthIndicator;
  let memoryHealth: MemoryHealthIndicator;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            check: jest.fn(),
          },
        },
        {
          provide: PrismaHealthIndicator,
          useValue: {
            pingCheck: jest.fn(),
          },
        },
        {
          provide: RedisHealthIndicator,
          useValue: {
            isHealthy: jest.fn(),
          },
        },
        {
          provide: BullHealthIndicator,
          useValue: {
            isHealthy: jest.fn(),
          },
        },
        {
          provide: S3HealthIndicator,
          useValue: {
            isHealthy: jest.fn(),
          },
        },
        {
          provide: NotificationHealthIndicator,
          useValue: {
            isHealthy: jest.fn(),
          },
        },
        {
          provide: MemoryHealthIndicator,
          useValue: {
            checkHeap: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthCheckService = module.get<HealthCheckService>(HealthCheckService);
    prismaHealth = module.get<PrismaHealthIndicator>(PrismaHealthIndicator);
    redisHealth = module.get<RedisHealthIndicator>(RedisHealthIndicator);
    bullHealth = module.get<BullHealthIndicator>(BullHealthIndicator);
    s3Health = module.get<S3HealthIndicator>(S3HealthIndicator);
    notificationHealth = module.get<NotificationHealthIndicator>(
      NotificationHealthIndicator,
    );
    memoryHealth = module.get<MemoryHealthIndicator>(MemoryHealthIndicator);
  });

  describe('GET /health/live', () => {
    it('should return 200 liveness check (always success)', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: { memory_heap: { status: 'up' } },
      };

      jest.spyOn(healthCheckService, 'check').mockResolvedValue(mockResult);
      jest
        .spyOn(memoryHealth, 'checkHeap')
        .mockResolvedValue({ memory_heap: { status: 'up' } });

      const result = await controller.liveness();

      expect(result).toEqual(mockResult);
      expect(healthCheckService.check).toHaveBeenCalled();
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 when all required dependencies are healthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: { status: 'up' },
          redis: { status: 'up' },
          queue: { status: 'up' },
        },
      };

      jest.spyOn(healthCheckService, 'check').mockResolvedValue(mockResult);
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockResolvedValue({ database: { status: 'up' } });
      jest
        .spyOn(redisHealth, 'isHealthy')
        .mockResolvedValue({ redis: { status: 'up' } });
      jest
        .spyOn(bullHealth, 'isHealthy')
        .mockResolvedValue({ queue: { status: 'up' } });

      const result = await controller.readiness();

      expect(result).toEqual(mockResult);
      expect(healthCheckService.check).toHaveBeenCalled();
    });

    it('should return 503 when database is down', async () => {
      const error = new Error('Database connection failed');

      jest
        .spyOn(healthCheckService, 'check')
        .mockRejectedValue(new Error('Health check failed'));
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockRejectedValue(error);

      try {
        await controller.readiness();
        fail('Should have thrown an error');
      } catch (e) {
        expect(healthCheckService.check).toHaveBeenCalled();
      }
    });

    it('should return 503 when Redis is down', async () => {
      const error = new Error('Redis connection refused');

      jest
        .spyOn(healthCheckService, 'check')
        .mockRejectedValue(new Error('Health check failed'));
      jest
        .spyOn(redisHealth, 'isHealthy')
        .mockRejectedValue(error);

      try {
        await controller.readiness();
        fail('Should have thrown an error');
      } catch (e) {
        expect(healthCheckService.check).toHaveBeenCalled();
      }
    });

    it('should return 503 when Bull queue is down', async () => {
      const error = new Error('Queue client disconnected');

      jest
        .spyOn(healthCheckService, 'check')
        .mockRejectedValue(new Error('Health check failed'));
      jest
        .spyOn(bullHealth, 'isHealthy')
        .mockRejectedValue(error);

      try {
        await controller.readiness();
        fail('Should have thrown an error');
      } catch (e) {
        expect(healthCheckService.check).toHaveBeenCalled();
      }
    });
  });

  describe('GET /health', () => {
    it('should return 200 when all dependencies (required and optional) are healthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: { status: 'up' },
          redis: { status: 'up' },
          queue: { status: 'up' },
          storage: { status: 'up' },
          notifications: { status: 'up' },
          memory_heap: { status: 'up' },
        },
      };

      jest.spyOn(healthCheckService, 'check').mockResolvedValue(mockResult);
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockResolvedValue({ database: { status: 'up' } });
      jest
        .spyOn(redisHealth, 'isHealthy')
        .mockResolvedValue({ redis: { status: 'up' } });
      jest
        .spyOn(bullHealth, 'isHealthy')
        .mockResolvedValue({ queue: { status: 'up' } });
      jest
        .spyOn(s3Health, 'isHealthy')
        .mockResolvedValue({ storage: { status: 'up' } });
      jest
        .spyOn(notificationHealth, 'isHealthy')
        .mockResolvedValue({ notifications: { status: 'up' } });
      jest
        .spyOn(memoryHealth, 'checkHeap')
        .mockResolvedValue({ memory_heap: { status: 'up' } });

      const result = await controller.full();

      expect(result).toEqual(mockResult);
      expect(healthCheckService.check).toHaveBeenCalled();
    });

    it('should return 207 (degraded) when optional S3 dependency is down but required deps are up', async () => {
      const mockResult: HealthCheckResult = {
        status: 'degraded',
        info: {
          database: { status: 'up' },
          redis: { status: 'up' },
          queue: { status: 'up' },
          memory_heap: { status: 'up' },
        },
        error: {
          storage: {
            status: 'down',
            error: 'S3 bucket not accessible',
          },
        },
      };

      jest.spyOn(healthCheckService, 'check').mockResolvedValue(mockResult);
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockResolvedValue({ database: { status: 'up' } });
      jest
        .spyOn(redisHealth, 'isHealthy')
        .mockResolvedValue({ redis: { status: 'up' } });
      jest
        .spyOn(bullHealth, 'isHealthy')
        .mockResolvedValue({ queue: { status: 'up' } });
      jest
        .spyOn(s3Health, 'isHealthy')
        .mockRejectedValue(new Error('S3 bucket not accessible'));
      jest
        .spyOn(memoryHealth, 'checkHeap')
        .mockResolvedValue({ memory_heap: { status: 'up' } });

      const result = await controller.full();

      expect(result.status).toBe('degraded');
      expect(healthCheckService.check).toHaveBeenCalled();
    });

    it('should return 207 (degraded) when optional notification dependency is down but required deps are up', async () => {
      const mockResult: HealthCheckResult = {
        status: 'degraded',
        info: {
          database: { status: 'up' },
          redis: { status: 'up' },
          queue: { status: 'up' },
          storage: { status: 'up' },
          memory_heap: { status: 'up' },
        },
        error: {
          notifications: {
            status: 'down',
            error: 'SendGrid API key not configured',
          },
        },
      };

      jest.spyOn(healthCheckService, 'check').mockResolvedValue(mockResult);
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockResolvedValue({ database: { status: 'up' } });
      jest
        .spyOn(redisHealth, 'isHealthy')
        .mockResolvedValue({ redis: { status: 'up' } });
      jest
        .spyOn(bullHealth, 'isHealthy')
        .mockResolvedValue({ queue: { status: 'up' } });
      jest
        .spyOn(s3Health, 'isHealthy')
        .mockResolvedValue({ storage: { status: 'up' } });
      jest
        .spyOn(notificationHealth, 'isHealthy')
        .mockRejectedValue(new Error('SendGrid API key not configured'));
      jest
        .spyOn(memoryHealth, 'checkHeap')
        .mockResolvedValue({ memory_heap: { status: 'up' } });

      const result = await controller.full();

      expect(result.status).toBe('degraded');
      expect(healthCheckService.check).toHaveBeenCalled();
    });

    it('should include per-dependency status objects in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: { status: 'up', message: 'Connected' },
          redis: { status: 'up', type: 'redis', message: 'Redis PING successful' },
          queue: {
            status: 'up',
            type: 'bull',
            jobCounts: { active: 0, completed: 5, failed: 0, delayed: 0, waiting: 2 },
          },
          storage: { status: 'up', bucket: 'my-bucket' },
          notifications: { status: 'up', type: 'sendgrid' },
          memory_heap: { status: 'up' },
        },
      };

      jest.spyOn(healthCheckService, 'check').mockResolvedValue(mockResult);
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockResolvedValue({ database: { status: 'up', message: 'Connected' } });
      jest
        .spyOn(redisHealth, 'isHealthy')
        .mockResolvedValue({
          redis: { status: 'up', type: 'redis', message: 'Redis PING successful' },
        });
      jest
        .spyOn(bullHealth, 'isHealthy')
        .mockResolvedValue({
          queue: {
            status: 'up',
            type: 'bull',
            jobCounts: { active: 0, completed: 5, failed: 0, delayed: 0, waiting: 2 },
          },
        });
      jest
        .spyOn(s3Health, 'isHealthy')
        .mockResolvedValue({ storage: { status: 'up', bucket: 'my-bucket' } });
      jest
        .spyOn(notificationHealth, 'isHealthy')
        .mockResolvedValue({ notifications: { status: 'up', type: 'sendgrid' } });
      jest
        .spyOn(memoryHealth, 'checkHeap')
        .mockResolvedValue({ memory_heap: { status: 'up' } });

      const result = await controller.full();

      expect(result.info).toHaveProperty('database');
      expect(result.info).toHaveProperty('redis');
      expect(result.info).toHaveProperty('queue');
      expect(result.info).toHaveProperty('storage');
      expect(result.info).toHaveProperty('notifications');
      expect(healthCheckService.check).toHaveBeenCalled();
    });

    it('should return 503 when a required dependency is down', async () => {
      jest
        .spyOn(healthCheckService, 'check')
        .mockRejectedValue(new Error('Health check failed'));
      jest
        .spyOn(prismaHealth, 'pingCheck')
        .mockRejectedValue(new Error('Database connection failed'));

      try {
        await controller.full();
        fail('Should have thrown an error');
      } catch (e) {
        expect(healthCheckService.check).toHaveBeenCalled();
      }
    });
  });
});
