export const SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES = 42_300;

export interface SharePointGraphTarget {
  readonly driveId: string;
  readonly externalTenantId: string;
  readonly folderId: string;
  readonly rootItemId: string;
  readonly siteId: string;
}

export interface SharePointGraphSubscription {
  readonly changeType: 'updated';
  readonly clientState: string;
  readonly expiresAt: Date;
  readonly id: string;
  readonly lifecycleNotificationUrl: string;
  readonly notificationUrl: string;
  readonly resource: string;
}

export type SharePointGraphItem =
  | {
      readonly id: string;
      readonly kind: 'DELETED';
      readonly parentId?: string;
    }
  | {
      readonly contentType?: string;
      readonly cTag?: string;
      readonly eTag: string;
      readonly id: string;
      readonly kind: 'FILE';
      readonly name: string;
      readonly parentId: string;
      readonly sizeBytes?: number;
    }
  | {
      readonly eTag: string;
      readonly id: string;
      readonly kind: 'FOLDER';
      readonly name: string;
      readonly parentId?: string;
    };

export interface SharePointGraphDeltaPage {
  readonly finalCursor?: string;
  readonly items: readonly SharePointGraphItem[];
  readonly nextCursor?: string;
}

export type SharePointGraphFailureCode =
  | 'GRAPH_CONFLICT'
  | 'GRAPH_NOT_FOUND'
  | 'GRAPH_OUTCOME_UNKNOWN'
  | 'GRAPH_PERMISSION_DENIED'
  | 'GRAPH_THROTTLED'
  | 'GRAPH_UNAVAILABLE';

export class SharePointGraphError extends Error {
  constructor(
    readonly code: SharePointGraphFailureCode,
    readonly retryAt?: Date,
  ) {
    super(code);
    this.name = 'SharePointGraphError';
  }
}

export interface SharePointGraphPort {
  createSubscription(input: {
    readonly changeType: 'updated';
    readonly clientState: string;
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly lifecycleNotificationUrl: string;
    readonly notificationUrl: string;
    readonly resource: string;
  }): Promise<SharePointGraphSubscription>;
  deleteSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
  }): Promise<void>;
  getSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
  }): Promise<SharePointGraphSubscription | undefined>;
  listDeltaPage(input: {
    readonly connectionId: string;
    readonly cursor?: string;
    readonly driveId: string;
  }): Promise<SharePointGraphDeltaPage>;
  listSubscriptions(input: {
    readonly connectionId: string;
  }): Promise<readonly SharePointGraphSubscription[]>;
  renewSubscription(input: {
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly subscriptionId: string;
  }): Promise<SharePointGraphSubscription>;
  resolveTarget(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly folderId: string;
    readonly siteId: string;
  }): Promise<SharePointGraphTarget>;
}
