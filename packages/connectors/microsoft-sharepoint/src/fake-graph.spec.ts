import { FakeSharePointGraphAdapter, SharePointGraphError } from './index';

const target = {
  connectionId: 'connection-1',
  driveId: 'drive-1',
  externalTenantId: 'external-tenant-1',
  folderId: 'folder-1',
  rootItemId: 'root-1',
  siteId: 'site-1',
};

const subscriptionInput = {
  changeType: 'updated' as const,
  clientState: 'v1.client-state',
  connectionId: 'connection-1',
  expiresAt: new Date('2026-08-20T00:00:00.000Z'),
  lifecycleNotificationUrl: 'https://engine.example.com/callback',
  notificationUrl: 'https://engine.example.com/callback',
  resource: 'drives/drive-1/root',
};

describe('fake SharePoint Graph adapter', () => {
  it('resolves only an exact connection and resource tuple', async () => {
    const graph = new FakeSharePointGraphAdapter([target]);

    await expect(graph.resolveTarget(target)).resolves.toEqual({
      driveId: target.driveId,
      externalTenantId: target.externalTenantId,
      folderId: target.folderId,
      rootItemId: target.rootItemId,
      siteId: target.siteId,
    });
    await expect(
      graph.resolveTarget({ ...target, connectionId: 'connection-2' }),
    ).rejects.toMatchObject({ code: 'GRAPH_NOT_FOUND' });
  });

  it('exposes timeout-after-create for safe list reconciliation', async () => {
    const graph = new FakeSharePointGraphAdapter([target]);
    graph.setBehavior('TIMEOUT_AFTER_CREATE');

    await expect(
      graph.createSubscription(subscriptionInput),
    ).rejects.toMatchObject({ code: 'GRAPH_OUTCOME_UNKNOWN' });

    graph.setBehavior('SUCCEED');
    await expect(
      graph.listSubscriptions({ connectionId: target.connectionId }),
    ).resolves.toHaveLength(1);
    await expect(
      graph.createSubscription(subscriptionInput),
    ).rejects.toMatchObject({ code: 'GRAPH_CONFLICT' });
  });

  it('provides deterministic delta pages and retry timing', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      finalCursor: 'opaque-delta-cursor',
      items: [],
    });

    await expect(
      graph.listDeltaPage({
        connectionId: target.connectionId,
        driveId: target.driveId,
      }),
    ).resolves.toEqual({
      finalCursor: 'opaque-delta-cursor',
      items: [],
    });

    graph.setBehavior('THROTTLE');
    await expect(
      graph.listDeltaPage({
        connectionId: target.connectionId,
        driveId: target.driveId,
      }),
    ).rejects.toEqual(
      new SharePointGraphError(
        'GRAPH_THROTTLED',
        new Date('2026-07-23T00:00:01.000Z'),
      ),
    );
  });
});
