import { IndexerService } from './indexer.service';

describe('IndexerService — chaos (Stellar RPC outage)', () => {
  const configService = {
    get: jest.fn((key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        STELLAR_NETWORK: 'testnet',
        STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
        INDEXER_POLL_INTERVAL_MS: 5000,
        INDEXER_MAX_EVENTS_PER_FETCH: 100,
      };
      return key in map ? map[key] : def;
    }),
  };
  const quarantinedEventRepository = { upsertEvent: jest.fn() };
  const ledgerTracker = {
    getLastCursor: jest.fn(),
    isEventProcessed: jest.fn(),
    markEventProcessed: jest.fn(),
    updateCursor: jest.fn(),
    logError: jest.fn(),
    logProgress: jest.fn(),
  };
  const eventHandler = { processEvent: jest.fn() };
  const xdrDecoder = {};
  const schedulerRegistry = { addInterval: jest.fn(), deleteInterval: jest.fn() };

  let service: IndexerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IndexerService(
      configService as any,
      quarantinedEventRepository as any,
      ledgerTracker as any,
      eventHandler as any,
      xdrDecoder as any,
      schedulerRegistry as any,
    );
  });

  it('retries RPC getEvents failures with the shared retry policy', async () => {
    (service as any).rpc = {
      getEvents: jest.fn().mockRejectedValue(new Error('rpc down')),
    };

    await expect((service as any).fetchEvents(1, 10)).rejects.toThrow('rpc down');
    // STELLAR_RPC_POLICY: 3 attempts per RPC call.
    expect((service as any).rpc.getEvents).toHaveBeenCalledTimes(3);
  });

  it('fails fast once the RPC circuit is open — no further RPC calls', async () => {
    (service as any).rpc = {
      getEvents: jest.fn().mockRejectedValue(new Error('rpc down')),
    };

    // Drive enough failures to trip the breaker (volumeThreshold 5, 3 fires/call).
    for (let i = 0; i < 3; i++) {
      await (service as any).fetchEvents(1, 10).catch(() => undefined);
    }
    const callsAfterTrips = (service as any).rpc.getEvents.mock.calls.length;

    await (service as any).fetchEvents(1, 10).catch(() => undefined);
    expect((service as any).rpc.getEvents.mock.calls.length).toBe(
      callsAfterTrips,
    );
  });

  it('resolves the latest ledger sequence through the breaker', async () => {
    (service as any).rpc = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 42 }),
    };

    await expect((service as any).getLatestLedger()).resolves.toBe(42);
    expect((service as any).rpc.getLatestLedger).toHaveBeenCalledTimes(1);
  });
});
