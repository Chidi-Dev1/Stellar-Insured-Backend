import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UserService } from '../src/user/user.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { RiskType } from '../src/insurance/enums/risk-type.enum';
import { Prisma } from '@prisma/client';

/**
 * The global ResponseTransformInterceptor wraps handler results in a
 * `{ success, data }` envelope, so unwrap defensively regardless of whether
 * the payload is the raw entity or the wrapped one.
 */
const unwrap = (body: any): any =>
  body && typeof body === 'object' && 'data' in body && !('id' in body)
    ? body.data
    : body;

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

      const body = unwrap(response.body);
      expect(body).toHaveProperty('id');
      expect(body.userId).toBe(userId);
      expect(body.poolId).toBe(pool.id);

      const policy = await prisma.insurancePolicy.findUnique({
        where: { id: body.id },
      });

      expect(policy).not.toBeNull();
      expect(policy?.status).toBe('ACTIVE');

      const updatedPool = await prisma.insurancePool.findUnique({
        where: { id: pool.id },
      });

      expect(updatedPool).not.toBeNull();
      expect(Number(updatedPool?.lockedCapital)).toBeGreaterThan(0);

      // Audit log row committed atomically with the policy…
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          entityType: 'InsurancePolicy',
          entityId: body.id,
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(auditLogs.some(log => log.action === 'PURCHASE')).toBe(true);

      // …and the purchase notification row committed with it (never queued
      // for a nonexistent entity).
      const notifications = await prisma.notification.findMany({
        where: {
          userId,
          type: 'POLICY_PURCHASED',
        },
      });
      expect(notifications.length).toBeGreaterThanOrEqual(1);

      await prisma.insurancePolicy.delete({ where: { id: body.id } });
      await prisma.notification.deleteMany({ where: { userId } });
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
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.insurancePool.delete({ where: { id: pool.id } });
    });
  });

  describe('/insurance/claims lifecycle (POST)', () => {
    it('creates, assesses, and pays a claim with transactional audit and notification outcomes', async () => {
      const pool = await prisma.insurancePool.create({
        data: { name: 'Claim Test Pool', capital: 100000 },
      });

      const policy = await insuranceService.purchasePolicy(
        userId,
        pool.id,
        RiskType.PROJECT_FAILURE,
        new Prisma.Decimal(10000),
      );

      // Create a claim for the full coverage amount so paying it fully
      // releases all locked capital (validates the unlock boundary).
      const createRes = await request(app.getHttpServer())
        .post('/insurance/claims')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ policyId: policy.id, claimAmount: 10000 })
        .expect(201);

      const claimId = unwrap(createRes.body).id;

      const createAudit = await prisma.auditLog.findFirst({
        where: { entityType: 'Claim', entityId: claimId, action: 'CREATE' },
      });
      expect(createAudit).not.toBeNull();

      const createdNotification = await prisma.notification.findFirst({
        where: { userId, type: 'CLAIM_CREATED' },
      });
      expect(createdNotification).not.toBeNull();

      // Assess → APPROVED (no capital movement yet).
      const assessRes = await request(app.getHttpServer())
        .post(`/insurance/claims/${claimId}/assess`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);
      expect(unwrap(assessRes.body).status).toBe('APPROVED');

      const approveAudit = await prisma.auditLog.findFirst({
        where: { entityType: 'Claim', entityId: claimId, action: 'APPROVE' },
      });
      expect(approveAudit).not.toBeNull();

      const approvedNotification = await prisma.notification.findFirst({
        where: { userId, type: 'CLAIM_APPROVED' },
      });
      expect(approvedNotification).not.toBeNull();

      const poolAfterApprove = await prisma.insurancePool.findUnique({
        where: { id: pool.id },
      });
      // Locked capital is untouched by approval — only the payout releases it.
      expect(Number(poolAfterApprove?.lockedCapital)).toBe(10000);

      // Pay → PAID and the claim amount is released from the pool.
      const payRes = await request(app.getHttpServer())
        .post(`/insurance/claims/${claimId}/pay`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);
      expect(unwrap(payRes.body).status).toBe('PAID');

      const payoutAudit = await prisma.auditLog.findFirst({
        where: { entityType: 'Claim', entityId: claimId, action: 'PAYOUT' },
      });
      expect(payoutAudit).not.toBeNull();

      const paidNotification = await prisma.notification.findFirst({
        where: { userId, type: 'CLAIM_PAID' },
      });
      expect(paidNotification).not.toBeNull();

      const poolAfterPay = await prisma.insurancePool.findUnique({
        where: { id: pool.id },
      });
      expect(Number(poolAfterPay?.lockedCapital)).toBe(0);

      await prisma.claim.deleteMany({ where: { id: claimId } });
      await prisma.insurancePolicy.delete({ where: { id: policy.id } });
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.insurancePool.delete({ where: { id: pool.id } });
    });

    it('rejects a claim whose amount exceeds the policy coverage, atomically', async () => {
      const pool = await prisma.insurancePool.create({
        data: { name: 'Claim Reject Pool', capital: 100000 },
      });

      const policy = await insuranceService.purchasePolicy(
        userId,
        pool.id,
        RiskType.PROJECT_FAILURE,
        new Prisma.Decimal(10000),
      );

      const createRes = await request(app.getHttpServer())
        .post('/insurance/claims')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ policyId: policy.id, claimAmount: 20000 })
        .expect(201);
      const claimId = unwrap(createRes.body).id;

      const assessRes = await request(app.getHttpServer())
        .post(`/insurance/claims/${claimId}/assess`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);
      expect(unwrap(assessRes.body).status).toBe('REJECTED');

      const rejectAudit = await prisma.auditLog.findFirst({
        where: { entityType: 'Claim', entityId: claimId, action: 'REJECT' },
      });
      expect(rejectAudit).not.toBeNull();

      const rejectedNotification = await prisma.notification.findFirst({
        where: { userId, type: 'CLAIM_REJECTED' },
      });
      expect(rejectedNotification).not.toBeNull();

      // Rejection releases the locked capital (unlockCapital inside the same
      // transaction as the status change).
      const poolAfterReject = await prisma.insurancePool.findUnique({
        where: { id: pool.id },
      });
      expect(Number(poolAfterReject?.lockedCapital)).toBe(0);

      await prisma.claim.deleteMany({ where: { id: claimId } });
      await prisma.insurancePolicy.delete({ where: { id: policy.id } });
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.insurancePool.delete({ where: { id: pool.id } });
    });
  });
});
