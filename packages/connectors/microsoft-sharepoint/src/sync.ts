import {
  SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES,
  SharePointGraphError,
  type SharePointGraphItem,
  type SharePointGraphPort,
  type SharePointGraphSubscription,
} from './graph-port';
import {
  deriveSharePointClientState,
  type SharePointClientStateKey,
} from './client-state';

const RENEWAL_LEAD_TIME_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_DELAY_MS = 5_000;
const SUBSCRIPTION_LIFETIME_MINUTES =
  SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES - 5;

export interface SharePointSyncClaim {
  readonly clientStateKeyVersion: number;
  readonly connectionId: string;
  readonly cursor?: string;
  readonly driveId: string;
  readonly inventoryGeneration: number;
  readonly mode: 'DELTA' | 'REBASELINE';
  readonly notificationGeneration: number;
  readonly projectId: string;
  readonly resource: string;
  readonly subscriptionExpiresAt?: Date;
  readonly subscriptionId?: string;
  readonly subscriptionStatus: 'ABSENT' | 'ACTIVE' | 'UNKNOWN';
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
  resetCursor(input: {
    readonly leaseOwner: string;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<void>;
  saveRenewedSubscription(input: {
    readonly leaseOwner: string;
    readonly subscription: SharePointGraphSubscription;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<void>;
  saveReconciledSubscription(input: {
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
  private readonly keys: ReadonlyMap<number, SharePointClientStateKey>;

  constructor(
    private readonly repository: SharePointSyncRepository,
    private readonly graph: SharePointGraphPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly subscriptionConfiguration?: {
      readonly callbackUrl: string;
      readonly keys: readonly SharePointClientStateKey[];
    },
  ) {
    this.keys = new Map(
      subscriptionConfiguration?.keys.map((key) => [key.keyVersion, key]) ?? [],
    );
  }

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
      let subscriptionExpiresAt = claim.subscriptionExpiresAt;
      let subscriptionId = claim.subscriptionId;
      if (
        claim.subscriptionStatus !== 'ACTIVE' ||
        subscriptionExpiresAt === undefined ||
        subscriptionId === undefined
      ) {
        const current =
          subscriptionId === undefined
            ? undefined
            : await this.graph.getSubscription({
                connectionId: claim.connectionId,
                subscriptionId,
                tenantId: claim.tenantId,
              });
        const subscription = current ?? (await this.createSubscription(claim));
        await this.repository.saveReconciledSubscription({
          leaseOwner: input.leaseOwner,
          subscription,
          tenantId: claim.tenantId,
          watchId: claim.watchId,
        });
        subscriptionExpiresAt = subscription.expiresAt;
        subscriptionId = subscription.id;
      }
      if (
        subscriptionExpiresAt !== undefined &&
        subscriptionId !== undefined &&
        subscriptionExpiresAt.getTime() - this.clock().getTime() <=
          RENEWAL_LEAD_TIME_MS
      ) {
        try {
          const subscription = await this.graph.renewSubscription({
            connectionId: claim.connectionId,
            expiresAt: this.desiredExpiry(),
            subscriptionId,
            tenantId: claim.tenantId,
          });
          await this.repository.saveRenewedSubscription({
            leaseOwner: input.leaseOwner,
            subscription,
            tenantId: claim.tenantId,
            watchId: claim.watchId,
          });
        } catch (error) {
          if (
            !(error instanceof SharePointGraphError) ||
            error.code !== 'GRAPH_NOT_FOUND'
          ) {
            throw error;
          }
          const subscription = await this.createSubscription(claim);
          await this.repository.saveReconciledSubscription({
            leaseOwner: input.leaseOwner,
            subscription,
            tenantId: claim.tenantId,
            watchId: claim.watchId,
          });
        }
      }
      const page = await this.graph.listDeltaPage({
        connectionId: claim.connectionId,
        ...(claim.cursor === undefined ? {} : { cursor: claim.cursor }),
        driveId: claim.driveId,
        tenantId: claim.tenantId,
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
        error.code === 'GRAPH_CURSOR_INVALID'
      ) {
        await this.repository.resetCursor({
          leaseOwner: input.leaseOwner,
          tenantId: claim.tenantId,
          watchId: claim.watchId,
        });
        return 'DEFERRED';
      }
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

  private async createSubscription(
    claim: SharePointSyncClaim,
  ): Promise<SharePointGraphSubscription> {
    const key = this.keys.get(claim.clientStateKeyVersion);
    const callbackUrl = this.subscriptionConfiguration?.callbackUrl;
    if (key === undefined || callbackUrl === undefined) {
      throw new Error('SHAREPOINT_SUBSCRIPTION_RECOVERY_NOT_CONFIGURED');
    }
    const clientState = deriveSharePointClientState(claim.watchId, key);
    const createInput = {
      changeType: 'updated' as const,
      clientState,
      connectionId: claim.connectionId,
      expiresAt: this.desiredExpiry(),
      lifecycleNotificationUrl: callbackUrl,
      notificationUrl: callbackUrl,
      resource: claim.resource,
      tenantId: claim.tenantId,
    };
    try {
      return await this.graph.createSubscription(createInput);
    } catch (error) {
      if (
        !(error instanceof SharePointGraphError) ||
        !['GRAPH_CONFLICT', 'GRAPH_OUTCOME_UNKNOWN'].includes(error.code)
      ) {
        throw error;
      }
      const matches = (
        await this.graph.listSubscriptions({
          connectionId: claim.connectionId,
          tenantId: claim.tenantId,
        })
      ).filter(
        (candidate) =>
          candidate.changeType === createInput.changeType &&
          candidate.clientState === createInput.clientState &&
          candidate.lifecycleNotificationUrl ===
            createInput.lifecycleNotificationUrl &&
          candidate.notificationUrl === createInput.notificationUrl &&
          candidate.resource === createInput.resource,
      );
      if (matches.length !== 1) throw error;
      return matches[0]!;
    }
  }

  private desiredExpiry(): Date {
    return new Date(
      this.clock().getTime() + SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1_000,
    );
  }
}
