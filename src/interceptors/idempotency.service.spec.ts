import { Prisma } from '@prisma/client';
import { IdempotencyService, IdempotencyClaim } from './idempotency.service';
import { PrismaService } from '../prisma.service';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  const prisma = {
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const expiresAt = new Date('2026-08-17T00:00:00Z');

  const claim: IdempotencyClaim = {
    key: 'k-1',
    method: 'POST',
    endpoint: '/v1/insurance/purchase',
    requestBody: { poolId: 'pool-1' },
    expiresAt,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IdempotencyService(prisma as unknown as PrismaService);
  });

  it('claims a new key as PENDING', async () => {
    prisma.idempotencyKey.create.mockResolvedValue({ id: '1' });

    const result = await service.claim(claim);

    expect(result).toBe('created');
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'k-1',
        method: 'POST',
        status: 'PENDING',
        requestBody: { poolId: 'pool-1' },
        expiresAt,
      }),
    });
  });

  it('returns conflict when a concurrent request wins the unique-key race', async () => {
    prisma.idempotencyKey.create.mockRejectedValue({ code: 'P2002' });

    await expect(service.claim(claim)).resolves.toBe('conflict');
  });

  it('rethrows non-unique failures so they surface as real errors', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(new Error('db down'));

    await expect(service.claim(claim)).rejects.toThrow('db down');
  });

  it('resets an existing key (expired/FAILED) back to PENDING', async () => {
    prisma.idempotencyKey.update.mockResolvedValue({});

    await service.resetToPending('k-1', {
      method: claim.method,
      endpoint: claim.endpoint,
      requestBody: claim.requestBody,
      expiresAt,
    });

    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'k-1' },
      data: expect.objectContaining({
        status: 'PENDING',
        response: Prisma.DbNull,
        deletedAt: null,
        expiresAt,
      }),
    });
  });

  it('marks a key COMPLETED with the cached response payload', async () => {
    prisma.idempotencyKey.update.mockResolvedValue({});

    await service.markCompleted('k-1', { id: 'policy-1' }, 201);

    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'k-1' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        response: { data: { id: 'policy-1' }, statusCode: 201 },
      }),
    });
  });

  it('marks a key FAILED with the error payload so retries can re-run', async () => {
    prisma.idempotencyKey.update.mockResolvedValue({});

    await service.markFailed('k-1', new Error('boom'), 500);

    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'k-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        response: { error: 'boom', statusCode: 500 },
      }),
    });
  });
});
