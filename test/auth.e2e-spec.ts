import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UserService } from '../src/user/user.service';
import { NonceService } from '../src/nonce/nonce.service';
import { createHash } from 'crypto';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let userService: UserService;
  let nonceService: NonceService;
  let userId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    authService = app.get<AuthService>(AuthService);
    userService = app.get<UserService>(UserService);
    nonceService = app.get<NonceService>(NonceService);

    const user = await userService.create(
      'GCUOWCH5OIO7H3SOIVWDSF3MHT6G2YKZRMXVI3P33YGRD7VNEV5MBQVN',
    );
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  // ── Wallet Login ─────────────────────────────────────────────────────

  describe('POST /auth/wallet-login', () => {
    it('should return access and refresh tokens for a valid nonce', async () => {
      const nonce = await nonceService.createNonce(userId);

      const response = await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(201);

      expect(response.body).toHaveProperty('access_token');
      expect(response.body).toHaveProperty('refresh_token');
      expect(response.body).toHaveProperty('expires_in');
      expect(response.body.token_type).toBe('Bearer');
    });

    it('should reject login with an invalid nonce', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce: 'invalid-nonce-value' })
        .expect(400);
    });

    it('should reject login with a nonce bound to a different user', async () => {
      const otherUser = await userService.create(
        'GBH2QV3VCYWJOKFDMRZR6WYQFZSGNJY5BHFVHIEPLZHXJKCVJF5RCQXH',
      );
      const nonce = await nonceService.createNonce(otherUser.id);

      await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(400);

      await prisma.user.delete({ where: { id: otherUser.id } });
    });

    it('should reject a nonce that has already been used (replay)', async () => {
      const nonce = await nonceService.createNonce(userId);

      await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(201);

      await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(400);
    });
  });

  // ── Token Refresh (Rotation) ─────────────────────────────────────────

  describe('POST /auth/refresh', () => {
    let refreshToken: string;

    beforeEach(async () => {
      const nonce = await nonceService.createNonce(userId);
      const loginResponse = await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(201);

      refreshToken = loginResponse.body.refresh_token;
    });

    it('should rotate tokens on valid refresh', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: refreshToken })
        .expect(201);

      expect(response.body).toHaveProperty('access_token');
      expect(response.body).toHaveProperty('refresh_token');
      expect(response.body.refresh_token).not.toBe(refreshToken);
    });

    it('should reject refresh with an invalid token', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: 'totally-invalid-token' })
        .expect(401);
    });

    it('should detect token reuse and revoke the entire family', async () => {
      const firstRefresh = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: refreshToken })

        .expect(201);

      const newRefreshToken = firstRefresh.body.refresh_token;

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: newRefreshToken })
        .expect(201);

      // Replay the OLD token
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: refreshToken })
        .expect(401);

      // The token from step 1 should also be revoked (family revocation)
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: newRefreshToken })
        .expect(401);
    });

    it('should reject refresh after logout revokes the token', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .send({ refresh_token: refreshToken })
        .set('Authorization', 'Bearer ' + (await getAccessToken()))
        .expect(200);

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: refreshToken })
        .expect(401);
    });
  });

  // ── Logout / Invalidation ────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('should revoke a specific refresh token', async () => {
      const nonce = await nonceService.createNonce(userId);
      const loginResponse = await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(201);

      const accessToken = loginResponse.body.access_token;
      const rt = loginResponse.body.refresh_token;

      const logoutResponse = await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .send({ refresh_token: rt })
        .set('Authorization', 'Bearer ' + accessToken)
        .expect(200);

      expect(logoutResponse.body.revoked).toBe(1);

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: rt })
        .expect(401);
    });

    it('should revoke all refresh tokens for a user on full logout', async () => {
      const nonce1 = await nonceService.createNonce(userId);
      const login1 = await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce: nonce1 })
        .expect(201);

      const nonce2 = await nonceService.createNonce(userId);
      const login2 = await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce: nonce2 })
        .expect(201);

      const accessToken1 = login1.body.access_token;
      const refreshToken2 = login2.body.refresh_token;

      const logoutResponse = await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .send({})
        .set('Authorization', 'Bearer ' + accessToken1)
        .expect(200);

      expect(logoutResponse.body.revoked).toBeGreaterThanOrEqual(2);

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: login1.body.refresh_token })
        .expect(401);

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: refreshToken2 })
        .expect(401);
    });
  });

  // ── Nonce Replay Prevention ──────────────────────────────────────────

  describe('Nonce replay prevention', () => {
    it('should prevent concurrent use of the same nonce', async () => {
      const nonce = await nonceService.createNonce(userId);

      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post('/v1/auth/wallet-login')
          .send({ userId, nonce }),
        request(app.getHttpServer())
          .post('/v1/auth/wallet-login')
          .send({ userId, nonce }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 400]);
    });
  });

  // ── Partial-Failure Recovery ─────────────────────────────────────────

  describe('Partial-failure recovery', () => {
    it('should leave DB consistent after token rotation', async () => {
      const nonce = await nonceService.createNonce(userId);
      const loginResponse = await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce })
        .expect(201);

      const refreshToken = loginResponse.body.refresh_token;

      const refreshResponse = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refresh_token: refreshToken })
        .expect(201);

      // Old token should be revoked
      const hashedOld = createHash('sha256').update(refreshToken).digest('hex');
      const dbToken = await prisma.refreshToken.findUnique({
        where: { token: hashedOld },
      });
      expect(dbToken).not.toBeNull();
      expect(dbToken!.revokedAt).not.toBeNull();

      // New token should be active
      const hashedNew = createHash('sha256')
        .update(refreshResponse.body.refresh_token)
        .digest('hex');
      const newDbToken = await prisma.refreshToken.findUnique({
        where: { token: hashedNew },
      });
      expect(newDbToken).not.toBeNull();
      expect(newDbToken!.revokedAt).toBeNull();
    });

    it('should not create dangling tokens on invalid nonce login', async () => {
      const countBefore = await prisma.refreshToken.count({
        where: { userId, revokedAt: null },
      });

      await request(app.getHttpServer())
        .post('/v1/auth/wallet-login')
        .send({ userId, nonce: 'invalid-nonce' })
        .expect(400);

      const countAfter = await prisma.refreshToken.count({
        where: { userId, revokedAt: null },
      });

      expect(countAfter).toBe(countBefore);
    });
  });

  // ── Helper ───────────────────────────────────────────────────────────

  async function getAccessToken(): Promise<string> {
    const nonce = await nonceService.createNonce(userId);
    const response = await request(app.getHttpServer())
      .post('/v1/auth/wallet-login')
      .send({ userId, nonce })
      .expect(201);
    return response.body.access_token;
  }
});
