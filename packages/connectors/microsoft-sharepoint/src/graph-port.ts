import type { Readable } from 'node:stream';

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
      readonly sizeBytes: number;
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

export type SharePointGraphResourceType = 'DRIVE' | 'FOLDER' | 'SITE';

export interface SharePointGraphResource {
  readonly containerResourceId?: string;
  readonly id: string;
  readonly label: string;
  readonly parentResourceId?: string;
  readonly resourceType: SharePointGraphResourceType;
  readonly rootResourceId?: string;
  readonly selectable: boolean;
}

export interface SharePointGraphResourcePage {
  readonly items: readonly SharePointGraphResource[];
  readonly nextCursor?: string;
}

export type SharePointGraphFailureCode =
  | 'GRAPH_CONFLICT'
  | 'GRAPH_CURSOR_INVALID'
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
    readonly tenantId: string;
  }): Promise<SharePointGraphSubscription>;
  deleteSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }): Promise<void>;
  getSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphSubscription | undefined>;
  getItem(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly itemId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphItem | undefined>;
  listDeltaPage(input: {
    readonly connectionId: string;
    readonly cursor?: string;
    readonly driveId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphDeltaPage>;
  listSubscriptions(input: {
    readonly connectionId: string;
    readonly tenantId: string;
  }): Promise<readonly SharePointGraphSubscription[]>;
  listResources(input: {
    readonly connectionId: string;
    readonly containerResourceId?: string;
    readonly cursor?: string;
    readonly parentResourceId?: string;
    readonly resourceType: SharePointGraphResourceType;
    readonly search?: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphResourcePage>;
  openFileContent(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly itemId: string;
    readonly tenantId: string;
  }): Promise<{
    readonly contentLength: number;
    readonly contentType: string;
    readonly stream: Readable;
  }>;
  renewSubscription(input: {
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphSubscription>;
  resolveTarget(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly folderId: string;
    readonly siteId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphTarget>;
}
