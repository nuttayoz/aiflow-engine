import { Readable } from 'node:stream';

import {
  SharePointGraphError,
  type SharePointGraphDeltaPage,
  type SharePointGraphPort,
  type SharePointGraphSubscription,
  type SharePointGraphTarget,
} from './graph-port';

export type FakeSharePointGraphBehavior =
  | 'CURSOR_INVALID'
  | 'SUCCEED'
  | 'THROTTLE'
  | 'TIMEOUT_AFTER_CREATE'
  | 'TIMEOUT_BEFORE_CREATE';

export const FAKE_SHAREPOINT_ANY_CONNECTION_ID =
  'fake-sharepoint-any-connection';
export const DEMO_SHAREPOINT_EXTERNAL_TENANT_ID =
  '00000000-0000-4000-8000-000000000001';
export const DEMO_SHAREPOINT_SITE_ID = 'demo-sharepoint-site';
export const DEMO_SHAREPOINT_DRIVE_ID = 'demo-sharepoint-drive';
export const DEMO_SHAREPOINT_ROOT_ID = 'demo-sharepoint-root';
export const DEMO_SHAREPOINT_FOLDER_ID = 'demo-sharepoint-inbound';

interface StoredSubscription extends SharePointGraphSubscription {
  readonly connectionId: string;
}

export class FakeSharePointGraphAdapter implements SharePointGraphPort {
  private behavior: FakeSharePointGraphBehavior = 'SUCCEED';
  private readonly deltaPages = new Map<string, SharePointGraphDeltaPage>();
  private readonly fileContents = new Map<string, Buffer>();
  private readonly items = new Map<
    string,
    SharePointGraphDeltaPage['items'][number]
  >();
  private readonly subscriptions = new Map<string, StoredSubscription>();
  private subscriptionSequence = 0;

  constructor(
    private readonly targets: readonly (SharePointGraphTarget & {
      readonly connectionId: string;
    })[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  setBehavior(behavior: FakeSharePointGraphBehavior): void {
    this.behavior = behavior;
  }

  setDeltaPage(
    connectionId: string,
    driveId: string,
    cursor: string | undefined,
    page: SharePointGraphDeltaPage,
  ): void {
    this.deltaPages.set(this.deltaKey(connectionId, driveId, cursor), page);
    for (const item of page.items) {
      this.items.set(this.itemKey(connectionId, driveId, item.id), item);
    }
  }

  setFileContent(
    connectionId: string,
    driveId: string,
    itemId: string,
    content: Uint8Array,
  ): void {
    this.fileContents.set(
      this.itemKey(connectionId, driveId, itemId),
      Buffer.from(content),
    );
  }

  async resolveTarget(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly folderId: string;
    readonly siteId: string;
  }): Promise<SharePointGraphTarget> {
    this.failBeforeRead();
    const target = this.targets.find(
      (candidate) =>
        (candidate.connectionId === input.connectionId ||
          candidate.connectionId === FAKE_SHAREPOINT_ANY_CONNECTION_ID) &&
        candidate.siteId === input.siteId &&
        candidate.driveId === input.driveId &&
        candidate.folderId === input.folderId,
    );
    if (target === undefined) {
      throw new SharePointGraphError('GRAPH_NOT_FOUND');
    }
    return {
      driveId: target.driveId,
      externalTenantId: target.externalTenantId,
      folderId: target.folderId,
      rootItemId: target.rootItemId,
      siteId: target.siteId,
    };
  }

  async createSubscription(input: {
    readonly changeType: 'updated';
    readonly clientState: string;
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly lifecycleNotificationUrl: string;
    readonly notificationUrl: string;
    readonly resource: string;
  }): Promise<SharePointGraphSubscription> {
    this.failBeforeMutation();
    if (this.behavior === 'TIMEOUT_BEFORE_CREATE') {
      throw new SharePointGraphError('GRAPH_OUTCOME_UNKNOWN');
    }
    const duplicate = [...this.subscriptions.values()].find(
      (subscription) =>
        subscription.connectionId === input.connectionId &&
        subscription.changeType === input.changeType &&
        subscription.resource === input.resource,
    );
    if (duplicate !== undefined) {
      throw new SharePointGraphError('GRAPH_CONFLICT');
    }
    this.subscriptionSequence += 1;
    const subscription: StoredSubscription = {
      ...input,
      id: `fake-subscription-${this.subscriptionSequence.toString()}`,
    };
    this.subscriptions.set(subscription.id, subscription);
    if (this.behavior === 'TIMEOUT_AFTER_CREATE') {
      throw new SharePointGraphError('GRAPH_OUTCOME_UNKNOWN');
    }
    return this.publicSubscription(subscription);
  }

  async getSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
  }): Promise<SharePointGraphSubscription | undefined> {
    this.failBeforeRead();
    const subscription = this.subscriptions.get(input.subscriptionId);
    return subscription?.connectionId === input.connectionId
      ? this.publicSubscription(subscription)
      : undefined;
  }

  async getItem(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly itemId: string;
  }) {
    this.failBeforeRead();
    return (
      this.items.get(
        this.itemKey(input.connectionId, input.driveId, input.itemId),
      ) ??
      this.items.get(
        this.itemKey(
          FAKE_SHAREPOINT_ANY_CONNECTION_ID,
          input.driveId,
          input.itemId,
        ),
      )
    );
  }

  async listSubscriptions(input: {
    readonly connectionId: string;
  }): Promise<readonly SharePointGraphSubscription[]> {
    this.failBeforeRead();
    return [...this.subscriptions.values()]
      .filter(
        (subscription) => subscription.connectionId === input.connectionId,
      )
      .map((subscription) => this.publicSubscription(subscription));
  }

  async listResources(input: {
    readonly connectionId: string;
    readonly containerResourceId?: string;
    readonly parentResourceId?: string;
    readonly resourceType: 'DRIVE' | 'FOLDER' | 'SITE';
    readonly search?: string;
  }) {
    this.failBeforeRead();
    const matchesConnection = (connectionId: string): boolean =>
      connectionId === input.connectionId ||
      connectionId === FAKE_SHAREPOINT_ANY_CONNECTION_ID;
    const normalizedSearch = input.search?.trim().toLocaleLowerCase();
    const matchesSearch = (label: string): boolean =>
      normalizedSearch === undefined ||
      normalizedSearch.length === 0 ||
      label.toLocaleLowerCase().includes(normalizedSearch);
    if (input.resourceType === 'SITE') {
      const sites = new Map<string, string>();
      for (const target of this.targets) {
        if (matchesConnection(target.connectionId)) {
          sites.set(target.siteId, 'Demo SharePoint site');
        }
      }
      return {
        items: [...sites].flatMap(([id, label]) =>
          matchesSearch(label)
            ? [
                {
                  id,
                  label,
                  resourceType: 'SITE' as const,
                  selectable: true,
                },
              ]
            : [],
        ),
      };
    }
    if (input.resourceType === 'DRIVE') {
      const drives = new Map<string, { rootItemId: string; siteId: string }>();
      for (const target of this.targets) {
        if (
          matchesConnection(target.connectionId) &&
          target.siteId === input.parentResourceId
        ) {
          drives.set(target.driveId, {
            rootItemId: target.rootItemId,
            siteId: target.siteId,
          });
        }
      }
      return {
        items: [...drives].flatMap(([id, drive]) => {
          const label = 'Documents';
          return matchesSearch(label)
            ? [
                {
                  id,
                  label,
                  parentResourceId: drive.siteId,
                  resourceType: 'DRIVE' as const,
                  rootResourceId: drive.rootItemId,
                  selectable: true,
                },
              ]
            : [];
        }),
      };
    }
    const folders = this.targets.flatMap((target) => {
      const parentResourceId = input.parentResourceId ?? target.rootItemId;
      const label = 'Inbound';
      return matchesConnection(target.connectionId) &&
        target.driveId === input.containerResourceId &&
        target.rootItemId === parentResourceId &&
        matchesSearch(label)
        ? [
            {
              containerResourceId: target.driveId,
              id: target.folderId,
              label,
              parentResourceId,
              resourceType: 'FOLDER' as const,
              selectable: true,
            },
          ]
        : [];
    });
    return { items: folders };
  }

  async openFileContent(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly itemId: string;
  }) {
    this.failBeforeRead();
    const item = await this.getItem(input);
    const content =
      this.fileContents.get(
        this.itemKey(input.connectionId, input.driveId, input.itemId),
      ) ??
      this.fileContents.get(
        this.itemKey(
          FAKE_SHAREPOINT_ANY_CONNECTION_ID,
          input.driveId,
          input.itemId,
        ),
      );
    if (item?.kind !== 'FILE' || content === undefined) {
      throw new SharePointGraphError('GRAPH_NOT_FOUND');
    }
    return {
      contentLength: content.byteLength,
      contentType: item.contentType ?? 'application/octet-stream',
      stream: Readable.from(content),
    };
  }

  async renewSubscription(input: {
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly subscriptionId: string;
  }): Promise<SharePointGraphSubscription> {
    this.failBeforeMutation();
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (
      subscription === undefined ||
      subscription.connectionId !== input.connectionId
    ) {
      throw new SharePointGraphError('GRAPH_NOT_FOUND');
    }
    const renewed = { ...subscription, expiresAt: input.expiresAt };
    this.subscriptions.set(subscription.id, renewed);
    return this.publicSubscription(renewed);
  }

  async deleteSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
  }): Promise<void> {
    this.failBeforeMutation();
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (
      subscription !== undefined &&
      subscription.connectionId === input.connectionId
    ) {
      this.subscriptions.delete(input.subscriptionId);
    }
  }

  async listDeltaPage(input: {
    readonly connectionId: string;
    readonly cursor?: string;
    readonly driveId: string;
  }): Promise<SharePointGraphDeltaPage> {
    this.failBeforeRead();
    const target = this.targets.find(
      (candidate) =>
        (candidate.connectionId === input.connectionId ||
          candidate.connectionId === FAKE_SHAREPOINT_ANY_CONNECTION_ID) &&
        candidate.driveId === input.driveId,
    );
    if (target === undefined) {
      throw new SharePointGraphError('GRAPH_NOT_FOUND');
    }
    const page =
      this.deltaPages.get(
        this.deltaKey(input.connectionId, input.driveId, input.cursor),
      ) ??
      this.deltaPages.get(
        this.deltaKey(
          FAKE_SHAREPOINT_ANY_CONNECTION_ID,
          input.driveId,
          input.cursor,
        ),
      );
    if (page === undefined) {
      throw new SharePointGraphError('GRAPH_NOT_FOUND');
    }
    return page;
  }

  private deltaKey(
    connectionId: string,
    driveId: string,
    cursor: string | undefined,
  ): string {
    return `${connectionId}\0${driveId}\0${cursor ?? 'initial'}`;
  }

  private itemKey(
    connectionId: string,
    driveId: string,
    itemId: string,
  ): string {
    return `${connectionId}\0${driveId}\0${itemId}`;
  }

  private failBeforeMutation(): void {
    if (this.behavior === 'THROTTLE') {
      throw new SharePointGraphError(
        'GRAPH_THROTTLED',
        new Date(this.clock().getTime() + 1_000),
      );
    }
  }

  private failBeforeRead(): void {
    if (this.behavior === 'CURSOR_INVALID') {
      throw new SharePointGraphError('GRAPH_CURSOR_INVALID');
    }
    if (this.behavior === 'THROTTLE') {
      throw new SharePointGraphError(
        'GRAPH_THROTTLED',
        new Date(this.clock().getTime() + 1_000),
      );
    }
  }

  private publicSubscription(
    subscription: StoredSubscription,
  ): SharePointGraphSubscription {
    return {
      changeType: subscription.changeType,
      clientState: subscription.clientState,
      expiresAt: subscription.expiresAt,
      id: subscription.id,
      lifecycleNotificationUrl: subscription.lifecycleNotificationUrl,
      notificationUrl: subscription.notificationUrl,
      resource: subscription.resource,
    };
  }
}

export const createDemoSharePointGraphAdapter = (): {
  readonly graph: FakeSharePointGraphAdapter;
  readonly target: SharePointGraphTarget & { readonly connectionId: string };
} => {
  const target = {
    connectionId: FAKE_SHAREPOINT_ANY_CONNECTION_ID,
    driveId: DEMO_SHAREPOINT_DRIVE_ID,
    externalTenantId: DEMO_SHAREPOINT_EXTERNAL_TENANT_ID,
    folderId: DEMO_SHAREPOINT_FOLDER_ID,
    rootItemId: DEMO_SHAREPOINT_ROOT_ID,
    siteId: DEMO_SHAREPOINT_SITE_ID,
  };
  const graph = new FakeSharePointGraphAdapter([target]);
  graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
    finalCursor: 'fake-baseline-delta-cursor',
    items: [
      {
        eTag: 'fake-folder-etag',
        id: target.folderId,
        kind: 'FOLDER',
        name: 'Inbound',
        parentId: target.rootItemId,
      },
    ],
  });
  const demoDocument = Buffer.from(
    '%PDF-1.4\nAiFlow local SharePoint entry proof\n%%EOF\n',
  );
  graph.setDeltaPage(
    target.connectionId,
    target.driveId,
    'fake-baseline-delta-cursor',
    {
      finalCursor: 'fake-live-delta-cursor',
      items: [
        {
          cTag: 'fake-demo-document-ctag',
          contentType: 'application/pdf',
          eTag: 'fake-demo-document-etag',
          id: 'fake-demo-document',
          kind: 'FILE',
          name: 'sharepoint-demo.pdf',
          parentId: target.folderId,
          sizeBytes: demoDocument.byteLength,
        },
      ],
    },
  );
  graph.setDeltaPage(
    target.connectionId,
    target.driveId,
    'fake-live-delta-cursor',
    {
      finalCursor: 'fake-live-delta-cursor',
      items: [],
    },
  );
  graph.setFileContent(
    target.connectionId,
    target.driveId,
    'fake-demo-document',
    demoDocument,
  );
  return { graph, target };
};
