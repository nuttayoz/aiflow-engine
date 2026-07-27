import {
  FakeSharePointGraphAdapter,
  type SharePointGraphItem,
  type SharePointSyncClaim,
  type SharePointSyncRepository,
  SharePointSyncProcessor,
} from './index';

const now = new Date('2026-07-23T00:00:00.000Z');
const target = {
  connectionId: 'connection-1',
  driveId: 'drive-1',
  externalTenantId: 'external-tenant-1',
  folderId: 'folder-1',
  rootItemId: 'root-1',
  siteId: 'site-1',
};
const claim: SharePointSyncClaim = {
  clientStateKeyVersion: 1,
  connectionId: target.connectionId,
  cursor: 'committed-cursor',
  driveId: target.driveId,
  inventoryGeneration: 1,
  mode: 'DELTA',
  notificationGeneration: 3,
  projectId: 'project-1',
  resource: 'drives/drive-1/root',
  subscriptionExpiresAt: new Date('2026-08-10T00:00:00.000Z'),
  subscriptionId: 'subscription-1',
  subscriptionStatus: 'ACTIVE',
  tenantId: 'tenant-1',
  watchId: 'watch-1',
};

class SyncRepository implements SharePointSyncRepository {
  appliedItems: readonly SharePointGraphItem[] = [];
  claimValue: SharePointSyncClaim = claim;
  deferredAt?: Date;
  cursorReset = false;
  reconciledSubscriptionId?: string;

  async claim() {
    return this.claimValue;
  }

  async saveRenewedSubscription() {}

  async saveReconciledSubscription(
    input: Parameters<
      SharePointSyncRepository['saveReconciledSubscription']
    >[0],
  ) {
    this.reconciledSubscriptionId = input.subscription.id;
  }

  async applyDeltaPage(
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
  ) {
    this.appliedItems = input.items;
  }

  async defer(input: Parameters<SharePointSyncRepository['defer']>[0]) {
    this.deferredAt = input.retryAt;
  }

  async resetCursor() {
    this.cursorReset = true;
  }
}

const input = {
  consumerName: 'sharepoint-sync',
  leaseDurationMs: 30_000,
  leaseOwner: 'worker-1',
  messageId: 'message-1',
  messageType:
    'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
  projectId: 'project-1',
  tenantId: 'tenant-1',
  watchId: 'watch-1',
};

describe('SharePoint sync processor', () => {
  it('keeps the last occurrence of an item in provider order', async () => {
    const repository = new SyncRepository();
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setDeltaPage(target.connectionId, target.driveId, claim.cursor, {
      finalCursor: 'next-committed-cursor',
      items: [
        {
          cTag: 'old-content',
          eTag: 'old-etag',
          id: 'file-1',
          kind: 'FILE',
          name: 'invoice.pdf',
          parentId: target.folderId,
          sizeBytes: 10,
        },
        {
          cTag: 'new-content',
          eTag: 'new-etag',
          id: 'file-1',
          kind: 'FILE',
          name: 'invoice.pdf',
          parentId: target.folderId,
          sizeBytes: 20,
        },
      ],
    });

    await expect(
      new SharePointSyncProcessor(repository, graph, () => now).process(input),
    ).resolves.toBe('PROCESSED');
    expect(repository.appliedItems).toEqual([
      expect.objectContaining({ cTag: 'new-content', sizeBytes: 20 }),
    ]);
  });

  it('turns Graph throttling into durable delayed work', async () => {
    const repository = new SyncRepository();
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setBehavior('THROTTLE');

    await expect(
      new SharePointSyncProcessor(repository, graph, () => now).process(input),
    ).resolves.toBe('DEFERRED');
    expect(repository.deferredAt).toEqual(new Date('2026-07-23T00:00:01.000Z'));
  });

  it('turns an expired delta cursor into a durable rebaseline', async () => {
    const repository = new SyncRepository();
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setBehavior('CURSOR_INVALID');

    await expect(
      new SharePointSyncProcessor(repository, graph, () => now).process(input),
    ).resolves.toBe('DEFERRED');
    expect(repository.cursorReset).toBe(true);
    expect(repository.deferredAt).toBeUndefined();
  });

  it('recreates a provider-side missing subscription before delta', async () => {
    const repository = new SyncRepository();
    repository.claimValue = { ...claim, subscriptionStatus: 'UNKNOWN' };
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setDeltaPage(target.connectionId, target.driveId, claim.cursor, {
      finalCursor: 'next-cursor',
      items: [],
    });
    const key = {
      keyVersion: 1,
      rootKey: new Uint8Array(32).fill(7),
    };

    await expect(
      new SharePointSyncProcessor(repository, graph, () => now, {
        callbackUrl:
          'http://localhost:3000/provider-callbacks/v1/microsoft-graph/sharepoint',
        keys: [key],
      }).process(input),
    ).resolves.toBe('PROCESSED');
    expect(repository.reconciledSubscriptionId).toBeDefined();
  });

  it('recreates an absent subscription after a last-reference race', async () => {
    const repository = new SyncRepository();
    repository.claimValue = {
      ...claim,
      subscriptionExpiresAt: undefined,
      subscriptionId: undefined,
      subscriptionStatus: 'ABSENT',
    };
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setDeltaPage(target.connectionId, target.driveId, claim.cursor, {
      finalCursor: 'next-cursor',
      items: [],
    });

    await expect(
      new SharePointSyncProcessor(repository, graph, () => now, {
        callbackUrl:
          'http://localhost:3000/provider-callbacks/v1/microsoft-graph/sharepoint',
        keys: [
          {
            keyVersion: 1,
            rootKey: new Uint8Array(32).fill(7),
          },
        ],
      }).process(input),
    ).resolves.toBe('PROCESSED');
    expect(repository.reconciledSubscriptionId).toBeDefined();
  });
});
