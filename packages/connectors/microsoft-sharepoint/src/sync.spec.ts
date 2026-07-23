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
  connectionId: target.connectionId,
  cursor: 'committed-cursor',
  driveId: target.driveId,
  notificationGeneration: 3,
  projectId: 'project-1',
  resource: 'drives/drive-1/root',
  subscriptionExpiresAt: new Date('2026-08-10T00:00:00.000Z'),
  subscriptionId: 'subscription-1',
  tenantId: 'tenant-1',
  watchId: 'watch-1',
};

class SyncRepository implements SharePointSyncRepository {
  appliedItems: readonly SharePointGraphItem[] = [];
  deferredAt?: Date;

  async claim() {
    return claim;
  }

  async saveRenewedSubscription() {}

  async applyDeltaPage(
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
  ) {
    this.appliedItems = input.items;
  }

  async defer(input: Parameters<SharePointSyncRepository['defer']>[0]) {
    this.deferredAt = input.retryAt;
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
});
