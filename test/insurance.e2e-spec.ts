import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UserService } from '../src/user/user.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { RiskType } from '../src/insurance/enums/risk-type.enum';

describe('InsuranceController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let userService: UserService;
  let insuranceService: InsuranceService;
  let authToken: string;
  let userId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    authService = app.get<AuthService>(AuthService);
    userService = app.get<UserService>(UserService);
    insuranceService = app.get<InsuranceService>(InsuranceService);

    const user = await userService.create('test@example.com');
    userId = user.id;

    authToken = (await authService.login(user)).access_token;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  describe('/insurance/purchase (POST)', () => {
    it('should purchase an insurance policy for an authenticated user', async () => {
      const pool = await prisma.insurancePool.create({
        data: {
          name: 'Test Pool',
          capital: 100000,
        },
      });

      const purchaseDto = {
        poolId: pool.id,
        riskType: RiskType.PROJECT_FAILURE,
        coverageAmount: 1000,
      };

      const response = await request(app.getHttpServer())
        .post('/insurance/purchase')
        .set('Authorization', `Bearer ${authToken}`)
        .send(purchaseDto)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.userId).toBe(userId);
      expect(response.body.poolId).toBe(pool.id);

      const policy = await prisma.insurancePolicy.findUnique({
        where: { id: response.body.id },
      });

      expect(policy).not.toBeNull();
      expect(policy?.status).toBe('ACTIVE');

      const updatedPool = await prisma.insurancePool.findUnique({
        where: { id: pool.id },
      });

      expect(updatedPool).not.toBeNull();
      expect(Number(updatedPool?.lockedCapital)).toBeGreaterThan(0);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          entityType: 'InsurancePolicy',
          entityId: response.body.id,
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(auditLogs.some(log => log.action === 'PURCHASE')).toBe(true);

      await prisma.insurancePolicy.delete({ where: { id: response.body.id } });
      await prisma.insurancePool.delete({ where: { id: pool.id } });
    });

    it('should not create duplicate policies for the same user and pool', async () => {
      const pool = await prisma.insurancePool.create({
        data: {
          name: 'Test Pool 2',
          capital: 100000,
        },
      });

      const purchaseDto = {
        poolId: pool.id,
        riskType: RiskType.PROJECT_FAILURE,
        coverageAmount: 1000,
      };

      await request(app.getHttpServer())
        .post('/insurance/purchase')
        .set('Authorization', `Bearer ${authToken}`)
        .send(purchaseDto)
        .expect(201);

      const policies = await prisma.insurancePolicy.findMany({
        where: {
          userId,
          poolId: pool.id,
          status: {
            in: ['ACTIVE', 'PENDING'],
          },
        },
      });

      expect(policies.length).toBe(1);

      await prisma.insurancePolicy.deleteMany({
        where: {
          userId,
          poolId: pool.id,
        },
      });
      await prisma.insurancePool.delete({ where: { id: pool.id } });
    });
  });
});