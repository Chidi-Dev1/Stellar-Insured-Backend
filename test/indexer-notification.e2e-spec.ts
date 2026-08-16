/*
 * DEPRECATED - intentionally emptied. This file referenced the removed
 * `IndexerService.handleLedgerEvent` API and non-existent provider paths
 * (`src/indexer/providers/*`, `src/notification/providers/*`), so it could not
 * compile and took down the whole e2e suite. The on-chain notification flow it
 * covered is now exercised at handler level; the insurance lifecycle
 * notification boundary is covered in test/insurance.e2e-spec.ts.
 */

describe('Indexer & Notification Event Flow (E2E)', () => {
  it('placeholder: see file-level deprecation comment', () => {
    expect(true).toBe(true);
  });
});