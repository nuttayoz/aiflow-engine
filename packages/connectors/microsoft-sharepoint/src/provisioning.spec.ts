import {
  FakeSharePointGraphAdapter,
  type SharePointGraphItem,
  type SharePointProvisioningRepository,
  type SharePointProvisioningState,
  SharePointManagedEntryProvisioner,
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
const prepareInput = {
  actionId: 'watch-folder',
  capabilityHash: 'a'.repeat(64),
  configuration: {
    driveId: target.driveId,
    folderId: target.folderId,
    includeSubfolders: true,
    siteId: target.siteId,
  },
  connectionId: target.connectionId,
  operationId: 'operation-1',
  projectId: 'project-1',
  tenantId: 'tenant-1',
  workflowId: 'workflow-1',
  workflowVersionId: 'version-1',
};

class ProvisioningRepository implements SharePointProvisioningRepository {
  state?: SharePointProvisioningState;
  readonly baselineItems: SharePointGraphItem[] = [];
  removalComplete = true;
  lastWatchReference = true;

  async beginRemoval() {
    if (this.state === undefined) throw new Error('MISSING_STATE');
    return {
      bindingId: this.state.bindingId,
      connectionId: this.state.connectionId,
      hasPendingIngestions: !this.removalComplete,
      lastWatchReference: this.lastWatchReference,
      ...(this.state.subscriptionId === undefined
        ? {}
        : { subscriptionId: this.state.subscriptionId }),
      tenantId: this.state.tenantId,
      watchId: this.state.watchId,
    };
  }

  async finishRemoval() {
    return { complete: this.removalComplete };
  }

  async ensureBindingAndWatch(
    input: Parameters<
      SharePointProvisioningRepository['ensureBindingAndWatch']
    >[0],
  ) {
    this.state ??= {
      baselineStatus: 'PENDING',
      bindingId: input.bindingId,
      clientStateDigest: input.clientStateDigest,
      clientStateKeyVersion: input.clientStateKeyVersion,
      connectionId: input.connectionId,
      driveId: input.target.driveId,
      externalTenantId: input.target.externalTenantId,
      resource: input.resource,
      siteId: input.target.siteId,
      stateVersion: 0,
      subscriptionStatus: 'ABSENT',
      tenantId: input.tenantId,
      watchId: input.watchId,
    };
    return this.state;
  }

  async saveSubscription(
    input: Parameters<SharePointProvisioningRepository['saveSubscription']>[0],
  ) {
    if (
      this.state === undefined ||
      this.state.stateVersion !== input.expectedStateVersion
    ) {
      throw new Error('STALE');
    }
    this.state = {
      ...this.state,
      stateVersion: this.state.stateVersion + 1,
      subscriptionExpiresAt: input.subscription.expiresAt,
      subscriptionId: input.subscription.id,
      subscriptionStatus: 'ACTIVE',
    };
    return this.state;
  }

  async saveBaselinePage(
    input: Parameters<SharePointProvisioningRepository['saveBaselinePage']>[0],
  ) {
    if (
      this.state === undefined ||
      this.state.stateVersion !== input.expectedStateVersion ||
      (input.nextCursor === undefined) === (input.finalCursor === undefined)
    ) {
      throw new Error('STALE');
    }
    this.baselineItems.push(...input.items);
    this.state = {
      ...this.state,
      baselineStatus: input.finalCursor === undefined ? 'RUNNING' : 'COMPLETE',
      ...(input.finalCursor === undefined
        ? {}
        : { committedDeltaCursor: input.finalCursor }),
      ...(input.nextCursor === undefined
        ? { scanNextCursor: undefined }
        : { scanNextCursor: input.nextCursor }),
      stateVersion: this.state.stateVersion + 1,
    };
    return this.state;
  }
}

const provisioner = (
  repository: SharePointProvisioningRepository,
  graph: FakeSharePointGraphAdapter,
) =>
  new SharePointManagedEntryProvisioner(
    repository,
    graph,
    [{ keyVersion: 1, rootKey: new Uint8Array(32).fill(9) }],
    1,
    'http://localhost:3000/provider-callbacks/v1/microsoft-graph/sharepoint',
    () => now,
  );

describe('SharePoint managed entry provisioner', () => {
  it('reconciles an ambiguous subscription create and ignores baseline files', async () => {
    const repository = new ProvisioningRepository();
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setBehavior('TIMEOUT_AFTER_CREATE');
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      finalCursor: 'opaque-final-cursor',
      items: [
        {
          eTag: 'folder-tag',
          id: target.folderId,
          kind: 'FOLDER',
          name: 'Inbound',
          parentId: target.rootItemId,
        },
        {
          cTag: 'content-tag',
          eTag: 'file-tag',
          id: 'existing-file-1',
          kind: 'FILE',
          name: 'existing.pdf',
          parentId: target.folderId,
          sizeBytes: 100,
        },
      ],
    });

    await expect(
      provisioner(repository, graph).prepare(prepareInput),
    ).resolves.toMatchObject({ status: 'READY' });
    expect(repository.state).toMatchObject({
      baselineStatus: 'COMPLETE',
      committedDeltaCursor: 'opaque-final-cursor',
      subscriptionStatus: 'ACTIVE',
    });
    expect(repository.baselineItems).toHaveLength(2);
  });

  it('does one delta page per attempt and honors Graph retry timing', async () => {
    const repository = new ProvisioningRepository();
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      items: [],
      nextCursor: 'opaque-page-2',
    });
    graph.setDeltaPage(target.connectionId, target.driveId, 'opaque-page-2', {
      finalCursor: 'opaque-final',
      items: [],
    });
    const managed = provisioner(repository, graph);

    await expect(managed.prepare(prepareInput)).resolves.toEqual({
      retryAt: new Date('2026-07-23T00:00:01.000Z'),
      status: 'PENDING',
    });
    await expect(managed.prepare(prepareInput)).resolves.toMatchObject({
      status: 'READY',
    });

    graph.setBehavior('THROTTLE');
    await expect(managed.prepare(prepareInput)).resolves.toEqual({
      retryAt: new Date('2026-07-23T00:00:01.000Z'),
      status: 'PENDING',
    });
  });

  it('deletes only the last shared subscription and waits for admitted work', async () => {
    const repository = new ProvisioningRepository();
    const graph = new FakeSharePointGraphAdapter([target], () => now);
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      finalCursor: 'opaque-final',
      items: [],
    });
    const managed = provisioner(repository, graph);
    await managed.prepare(prepareInput);
    const subscriptionId = repository.state?.subscriptionId;
    expect(subscriptionId).toBeDefined();

    repository.removalComplete = false;
    await expect(managed.remove(prepareInput)).resolves.toEqual({
      retryAt: new Date('2026-07-23T00:00:01.000Z'),
      status: 'PENDING',
    });
    await expect(
      graph.getSubscription({
        connectionId: target.connectionId,
        subscriptionId: subscriptionId!,
      }),
    ).resolves.toBeUndefined();

    repository.removalComplete = true;
    await expect(managed.remove(prepareInput)).resolves.toEqual({
      status: 'READY',
    });
  });
});
