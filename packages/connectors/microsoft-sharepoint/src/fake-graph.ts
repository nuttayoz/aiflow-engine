import {
  SharePointGraphError,
  type SharePointGraphDeltaPage,
  type SharePointGraphPort,
  type SharePointGraphSubscription,
  type SharePointGraphTarget,
} from './graph-port';

export type FakeSharePointGraphBehavior =
  'SUCCEED' | 'THROTTLE' | 'TIMEOUT_AFTER_CREATE' | 'TIMEOUT_BEFORE_CREATE';

export const FAKE_SHAREPOINT_ANY_CONNECTION_ID =
  'fake-sharepoint-any-connection';

interface StoredSubscription extends SharePointGraphSubscription {
  readonly connectionId: string;
}

export class FakeSharePointGraphAdapter implements SharePointGraphPort {
  private behavior: FakeSharePointGraphBehavior = 'SUCCEED';
  private readonly deltaPages = new Map<string, SharePointGraphDeltaPage>();
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

  private failBeforeMutation(): void {
    if (this.behavior === 'THROTTLE') {
      throw new SharePointGraphError(
        'GRAPH_THROTTLED',
        new Date(this.clock().getTime() + 1_000),
      );
    }
  }

  private failBeforeRead(): void {
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
