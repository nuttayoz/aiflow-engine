import {
  SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES,
  SharePointGraphError,
  type SharePointGraphItem,
  type SharePointGraphPort,
  type SharePointGraphSubscription,
} from './graph-port';

const RENEWAL_LEAD_TIME_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_DELAY_MS = 5_000;
const SUBSCRIPTION_LIFETIME_MINUTES =
  SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES - 5;

export interface SharePointSyncClaim {
  readonly connectionId: string;
  readonly cursor: string;
  readonly driveId: string;
  readonly notificationGeneration: number;
  readonly projectId: string;
  readonly resource: string;
  readonly subscriptionExpiresAt: Date;
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly watchId: string;
}

export interface SharePointSyncRepository {
  applyDeltaPage(input: {
    readonly claim: SharePointSyncClaim;
    readonly finalCursor?: string;
    readonly items: readonly SharePointGraphItem[];
    readonly leaseOwner: string;
    readonly nextCursor?: string;
    readonly observedAt: Date;
  }): Promise<void>;
  claim(input: {
    readonly consumerName: string;
    readonly leaseDurationMs: number;
    readonly leaseOwner: string;
    readonly messageId: string;
    readonly messageType: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<SharePointSyncClaim | undefined>;
  defer(input: {
    readonly leaseOwner: string;
    readonly retryAt: Date;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<void>;
  saveRenewedSubscription(input: {
    readonly leaseOwner: string;
    readonly subscription: SharePointGraphSubscription;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<void>;
}

export type SharePointSyncOutcome = 'DEFERRED' | 'PROCESSED' | 'STALE';

const keepLastItemOccurrence = (
  items: readonly SharePointGraphItem[],
): readonly SharePointGraphItem[] => {
  const last = new Map<string, SharePointGraphItem>();
  for (const item of items) {
    last.delete(item.id);
    last.set(item.id, item);
  }
  return [...last.values()];
};

export class SharePointSyncProcessor {
  constructor(
    private readonly repository: SharePointSyncRepository,
    private readonly graph: SharePointGraphPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(input: {
    readonly consumerName: string;
    readonly leaseDurationMs: number;
    readonly leaseOwner: string;
    readonly messageId: string;
    readonly messageType: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<SharePointSyncOutcome> {
    const claim = await this.repository.claim(input);
    if (claim === undefined) return 'STALE';
    try {
      if (
        claim.subscriptionExpiresAt.getTime() - this.clock().getTime() <=
        RENEWAL_LEAD_TIME_MS
      ) {
        const subscription = await this.graph.renewSubscription({
          connectionId: claim.connectionId,
          expiresAt: new Date(
            this.clock().getTime() + SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1_000,
          ),
          subscriptionId: claim.subscriptionId,
        });
        await this.repository.saveRenewedSubscription({
          leaseOwner: input.leaseOwner,
          subscription,
          tenantId: claim.tenantId,
          watchId: claim.watchId,
        });
      }
      const page = await this.graph.listDeltaPage({
        connectionId: claim.connectionId,
        cursor: claim.cursor,
        driveId: claim.driveId,
      });
      await this.repository.applyDeltaPage({
        claim,
        ...(page.finalCursor === undefined
          ? {}
          : { finalCursor: page.finalCursor }),
        items: keepLastItemOccurrence(page.items),
        leaseOwner: input.leaseOwner,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
        observedAt: this.clock(),
      });
      return 'PROCESSED';
    } catch (error) {
      if (
        error instanceof SharePointGraphError &&
        [
          'GRAPH_OUTCOME_UNKNOWN',
          'GRAPH_THROTTLED',
          'GRAPH_UNAVAILABLE',
        ].includes(error.code)
      ) {
        await this.repository.defer({
          leaseOwner: input.leaseOwner,
          retryAt:
            error.retryAt ?? new Date(this.clock().getTime() + RETRY_DELAY_MS),
          tenantId: claim.tenantId,
          watchId: claim.watchId,
        });
        return 'DEFERRED';
      }
      throw error;
    }
  }
}
