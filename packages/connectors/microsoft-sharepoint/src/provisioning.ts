import { createHash, randomUUID } from 'node:crypto';

import type { ManagedEntryProvisioner } from '@aiflow/workflows';

import {
  deriveSharePointClientState,
  sharePointClientStateDigest,
  type SharePointClientStateKey,
} from './client-state';
import {
  isSharePointEntryConfiguration,
  type SharePointEntryConfiguration,
} from './configuration';
import {
  SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES,
  SharePointGraphError,
  type SharePointGraphItem,
  type SharePointGraphPort,
  type SharePointGraphSubscription,
  type SharePointGraphTarget,
} from './graph-port';

const RENEWAL_LEAD_TIME_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_DELAY_MS = 1_000;
const SUBSCRIPTION_LIFETIME_MINUTES =
  SHAREPOINT_SUBSCRIPTION_MAX_LIFETIME_MINUTES - 5;

export interface SharePointProvisioningState {
  readonly baselineStatus: 'COMPLETE' | 'FAILED' | 'PENDING' | 'RUNNING';
  readonly bindingId: string;
  readonly clientStateDigest: string;
  readonly clientStateKeyVersion: number;
  readonly committedDeltaCursor?: string;
  readonly connectionId: string;
  readonly driveId: string;
  readonly externalTenantId: string;
  readonly resource: string;
  readonly scanNextCursor?: string;
  readonly siteId: string;
  readonly stateVersion: number;
  readonly subscriptionExpiresAt?: Date;
  readonly subscriptionId?: string;
  readonly subscriptionStatus: 'ABSENT' | 'ACTIVE' | 'FAILED' | 'UNKNOWN';
  readonly tenantId: string;
  readonly watchId: string;
}

export interface SharePointProvisioningRepository {
  ensureBindingAndWatch(input: {
    readonly bindingId: string;
    readonly capabilityHash: string;
    readonly clientStateDigest: string;
    readonly clientStateKeyVersion: number;
    readonly configuration: SharePointEntryConfiguration;
    readonly configurationHash: string;
    readonly connectionId: string;
    readonly operationId: string;
    readonly projectId: string;
    readonly resource: string;
    readonly target: SharePointGraphTarget;
    readonly tenantId: string;
    readonly watchId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
  }): Promise<SharePointProvisioningState>;
  saveBaselinePage(input: {
    readonly bindingId: string;
    readonly expectedStateVersion: number;
    readonly finalCursor?: string;
    readonly items: readonly SharePointGraphItem[];
    readonly nextCursor?: string;
    readonly observedAt: Date;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<SharePointProvisioningState>;
  saveSubscription(input: {
    readonly bindingId: string;
    readonly expectedStateVersion: number;
    readonly subscription: SharePointGraphSubscription;
    readonly tenantId: string;
    readonly watchId: string;
  }): Promise<SharePointProvisioningState>;
}

const configurationHash = (
  configuration: SharePointEntryConfiguration,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        driveId: configuration.driveId,
        folderId: configuration.folderId,
        includeSubfolders: configuration.includeSubfolders,
        siteId: configuration.siteId,
      }),
    )
    .digest('hex');

export class SharePointManagedEntryProvisioner implements ManagedEntryProvisioner {
  readonly connectorId = 'microsoft-sharepoint';
  private readonly keys: ReadonlyMap<number, SharePointClientStateKey>;

  constructor(
    private readonly repository: SharePointProvisioningRepository,
    private readonly graph: SharePointGraphPort,
    keys: readonly SharePointClientStateKey[],
    private readonly currentKeyVersion: number,
    private readonly callbackUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.keys = new Map(keys.map((key) => [key.keyVersion, key]));
    const parsedCallbackUrl = new URL(callbackUrl);
    if (
      this.keys.size !== keys.length ||
      !this.keys.has(currentKeyVersion) ||
      !['http:', 'https:'].includes(parsedCallbackUrl.protocol) ||
      parsedCallbackUrl.username.length > 0 ||
      parsedCallbackUrl.password.length > 0
    ) {
      throw new Error('SHAREPOINT_PROVISIONER_CONFIGURATION_INVALID');
    }
  }

  async prepare(input: {
    readonly actionId: string;
    readonly capabilityHash: string;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly connectionId: string;
    readonly operationId: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
  }) {
    if (
      input.actionId !== 'watch-folder' ||
      !isSharePointEntryConfiguration(input.configuration)
    ) {
      throw new Error('SHAREPOINT_ENTRY_CONFIGURATION_INVALID');
    }
    try {
      const target = await this.graph.resolveTarget({
        connectionId: input.connectionId,
        driveId: input.configuration.driveId,
        folderId: input.configuration.folderId,
        siteId: input.configuration.siteId,
      });
      let state = await this.ensureState(input, input.configuration, target);
      state = await this.ensureSubscription(state);
      if (state.baselineStatus !== 'COMPLETE') {
        const page = await this.graph.listDeltaPage({
          connectionId: state.connectionId,
          ...(state.scanNextCursor === undefined
            ? {}
            : { cursor: state.scanNextCursor }),
          driveId: state.driveId,
        });
        state = await this.repository.saveBaselinePage({
          bindingId: state.bindingId,
          expectedStateVersion: state.stateVersion,
          ...(page.finalCursor === undefined
            ? {}
            : { finalCursor: page.finalCursor }),
          items: page.items,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
          observedAt: this.clock(),
          tenantId: state.tenantId,
          watchId: state.watchId,
        });
      }
      return state.baselineStatus === 'COMPLETE'
        ? { bindingId: state.bindingId, status: 'READY' as const }
        : { retryAt: this.retryAt(), status: 'PENDING' as const };
    } catch (error) {
      if (error instanceof SharePointGraphError) {
        if (error.code === 'GRAPH_THROTTLED' && error.retryAt !== undefined) {
          return { retryAt: error.retryAt, status: 'PENDING' as const };
        }
        if (
          error.code === 'GRAPH_UNAVAILABLE' ||
          error.code === 'GRAPH_OUTCOME_UNKNOWN'
        ) {
          return { retryAt: this.retryAt(), status: 'PENDING' as const };
        }
      }
      throw error;
    }
  }

  private async ensureState(
    input: {
      readonly capabilityHash: string;
      readonly connectionId: string;
      readonly operationId: string;
      readonly projectId: string;
      readonly tenantId: string;
      readonly workflowId: string;
      readonly workflowVersionId: string;
    },
    configuration: SharePointEntryConfiguration,
    target: SharePointGraphTarget,
  ): Promise<SharePointProvisioningState> {
    const watchId = randomUUID();
    const key = this.requireKey(this.currentKeyVersion);
    const clientState = deriveSharePointClientState(watchId, key);
    return this.repository.ensureBindingAndWatch({
      bindingId: randomUUID(),
      capabilityHash: input.capabilityHash,
      clientStateDigest: sharePointClientStateDigest(clientState),
      clientStateKeyVersion: key.keyVersion,
      configuration,
      configurationHash: configurationHash(configuration),
      connectionId: input.connectionId,
      operationId: input.operationId,
      projectId: input.projectId,
      resource: `drives/${configuration.driveId}/root`,
      target,
      tenantId: input.tenantId,
      watchId,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
    });
  }

  private async ensureSubscription(
    state: SharePointProvisioningState,
  ): Promise<SharePointProvisioningState> {
    if (
      state.subscriptionStatus === 'ACTIVE' &&
      state.subscriptionId !== undefined &&
      state.subscriptionExpiresAt !== undefined
    ) {
      if (
        state.subscriptionExpiresAt.getTime() - this.clock().getTime() >
        RENEWAL_LEAD_TIME_MS
      ) {
        return state;
      }
      const renewed = await this.graph.renewSubscription({
        connectionId: state.connectionId,
        expiresAt: this.desiredExpiry(),
        subscriptionId: state.subscriptionId,
      });
      return this.repository.saveSubscription({
        bindingId: state.bindingId,
        expectedStateVersion: state.stateVersion,
        subscription: renewed,
        tenantId: state.tenantId,
        watchId: state.watchId,
      });
    }

    const key = this.requireKey(state.clientStateKeyVersion);
    const clientState = deriveSharePointClientState(state.watchId, key);
    const createInput = {
      changeType: 'updated' as const,
      clientState,
      connectionId: state.connectionId,
      expiresAt: this.desiredExpiry(),
      lifecycleNotificationUrl: this.callbackUrl,
      notificationUrl: this.callbackUrl,
      resource: state.resource,
    };
    let subscription: SharePointGraphSubscription;
    try {
      subscription = await this.graph.createSubscription(createInput);
    } catch (error) {
      if (
        !(error instanceof SharePointGraphError) ||
        !['GRAPH_CONFLICT', 'GRAPH_OUTCOME_UNKNOWN'].includes(error.code)
      ) {
        throw error;
      }
      const matches = (
        await this.graph.listSubscriptions({
          connectionId: state.connectionId,
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
      if (matches.length > 1) {
        throw new Error('SHAREPOINT_SUBSCRIPTION_INTEGRITY_CONFLICT', {
          cause: error,
        });
      }
      if (matches[0] === undefined) {
        if (error.code === 'GRAPH_CONFLICT') {
          throw new Error('SHAREPOINT_SUBSCRIPTION_CONFLICT', { cause: error });
        }
        throw error;
      }
      subscription = matches[0];
    }
    return this.repository.saveSubscription({
      bindingId: state.bindingId,
      expectedStateVersion: state.stateVersion,
      subscription,
      tenantId: state.tenantId,
      watchId: state.watchId,
    });
  }

  private desiredExpiry(): Date {
    return new Date(
      this.clock().getTime() + SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1_000,
    );
  }

  private requireKey(keyVersion: number): SharePointClientStateKey {
    const key = this.keys.get(keyVersion);
    if (key === undefined)
      throw new Error('SHAREPOINT_CLIENT_STATE_KEY_MISSING');
    return key;
  }

  private retryAt(): Date {
    return new Date(this.clock().getTime() + RETRY_DELAY_MS);
  }
}
