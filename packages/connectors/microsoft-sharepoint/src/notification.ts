import { createHash } from 'node:crypto';

import { verifySharePointClientStateDigest } from './client-state';

export const SHAREPOINT_CALLBACK_MAX_BODY_BYTES = 64 * 1024;
export const SHAREPOINT_CALLBACK_MAX_NOTIFICATIONS = 100;
export const SHAREPOINT_VALIDATION_TOKEN_MAX_LENGTH = 4_096;

interface SharePointChangeNotification {
  readonly changeType: 'updated';
  readonly clientState: string;
  readonly id?: string;
  readonly kind: 'CHANGE';
  readonly resource: string;
  readonly subscriptionId: string;
  readonly tenantId: string;
}

interface SharePointLifecycleNotification {
  readonly clientState: string;
  readonly id?: string;
  readonly kind: 'REAUTHORIZATION_REQUIRED';
  readonly subscriptionId: string;
  readonly tenantId: string;
}

export type SharePointNotification =
  SharePointChangeNotification | SharePointLifecycleNotification;

export interface SharePointNotificationWatch {
  readonly changeType: 'updated';
  readonly clientStateDigest: string;
  readonly externalTenantId: string;
  readonly projectId: string;
  readonly resource: string;
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly watchId: string;
}

export interface RecordSharePointNotificationInput {
  readonly bodySha256: string;
  readonly eventKeyHash: string;
  readonly expectedClientStateDigest: string;
  readonly expectedResource: string;
  readonly expectedSubscriptionId: string;
  readonly notificationKind: 'CHANGE' | 'REAUTHORIZATION_REQUIRED';
  readonly projectId: string;
  readonly receivedAt: Date;
  readonly tenantId: string;
  readonly watchId: string;
}

export type RecordSharePointNotificationResult =
  'ACCEPTED' | 'DUPLICATE' | 'STALE';

export interface SharePointNotificationRepository {
  findWatchBySubscriptionId(
    subscriptionId: string,
  ): Promise<SharePointNotificationWatch | undefined>;
  recordVerifiedNotification(
    input: RecordSharePointNotificationInput,
  ): Promise<RecordSharePointNotificationResult>;
}

export interface SharePointNotificationIntakeResult {
  readonly accepted: number;
  readonly discarded: number;
  readonly duplicate: number;
}

const allowedNotificationKeys = [
  'changeType',
  'clientState',
  'id',
  'lifecycleEvent',
  'resource',
  'resourceData',
  'subscriptionExpirationDateTime',
  'subscriptionId',
  'tenantId',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const boundedString = (
  value: unknown,
  maximumLength: number,
): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximumLength;

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isSafeResourceData = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const keys = ['@odata.id', '@odata.type', 'id'];
  return (
    hasOnlyKeys(value, keys) &&
    Object.values(value).every((field) => boundedString(field, 1_024))
  );
};

const hasSafeExpiration = (value: unknown): boolean =>
  value === undefined ||
  (boundedString(value, 64) && Number.isFinite(Date.parse(value)));

const parseNotification = (
  value: unknown,
): SharePointNotification | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, allowedNotificationKeys) ||
    !boundedString(value.subscriptionId, 512) ||
    !boundedString(value.clientState, 255) ||
    !boundedString(value.tenantId, 180) ||
    (value.id !== undefined && !boundedString(value.id, 512)) ||
    !hasSafeExpiration(value.subscriptionExpirationDateTime) ||
    !isSafeResourceData(value.resourceData)
  ) {
    return undefined;
  }

  const common = {
    clientState: value.clientState,
    ...(value.id === undefined ? {} : { id: value.id }),
    subscriptionId: value.subscriptionId,
    tenantId: value.tenantId,
  };
  if (
    value.changeType === 'updated' &&
    value.lifecycleEvent === undefined &&
    boundedString(value.resource, 768)
  ) {
    return {
      ...common,
      changeType: 'updated',
      kind: 'CHANGE',
      resource: value.resource,
    };
  }
  if (
    value.lifecycleEvent === 'reauthorizationRequired' &&
    value.changeType === undefined &&
    value.resource === undefined &&
    value.resourceData === undefined
  ) {
    return {
      ...common,
      kind: 'REAUTHORIZATION_REQUIRED',
    };
  }
  return undefined;
};

export const parseSharePointNotificationCollection = (
  value: unknown,
): readonly SharePointNotification[] => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['value']) ||
    !Array.isArray(value.value) ||
    value.value.length === 0 ||
    value.value.length > SHAREPOINT_CALLBACK_MAX_NOTIFICATIONS
  ) {
    throw new Error('SHAREPOINT_NOTIFICATION_INVALID');
  }
  const notifications = value.value.map(parseNotification);
  if (notifications.some((notification) => notification === undefined)) {
    throw new Error('SHAREPOINT_NOTIFICATION_INVALID');
  }
  return notifications as readonly SharePointNotification[];
};

export const validateSharePointValidationToken = (value: unknown): string => {
  if (
    !boundedString(value, SHAREPOINT_VALIDATION_TOKEN_MAX_LENGTH) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('SHAREPOINT_VALIDATION_TOKEN_INVALID');
  }
  return value;
};

const eventKeyHash = (
  notification: SharePointNotification,
  bodySha256: string,
  receivedAt: Date,
): string => {
  const fiveMinuteBucket = Math.floor(receivedAt.getTime() / (5 * 60 * 1_000));
  const identity =
    notification.id === undefined
      ? JSON.stringify({
          bodySha256,
          fiveMinuteBucket,
          kind: notification.kind,
          resource:
            notification.kind === 'CHANGE' ? notification.resource : undefined,
          subscriptionId: notification.subscriptionId,
          tenantId: notification.tenantId,
        })
      : `id:${notification.id}`;
  return createHash('sha256').update(identity).digest('hex');
};

export class SharePointNotificationIntake {
  constructor(private readonly repository: SharePointNotificationRepository) {}

  async accept(input: {
    readonly body: unknown;
    readonly bodySha256: string;
    readonly receivedAt: Date;
  }): Promise<SharePointNotificationIntakeResult> {
    const notifications = parseSharePointNotificationCollection(input.body);
    let accepted = 0;
    let discarded = 0;
    let duplicate = 0;

    for (const notification of notifications) {
      const watch = await this.repository.findWatchBySubscriptionId(
        notification.subscriptionId,
      );
      if (!this.matchesWatch(notification, watch)) {
        discarded += 1;
        continue;
      }
      const outcome = await this.repository.recordVerifiedNotification({
        bodySha256: input.bodySha256,
        eventKeyHash: eventKeyHash(
          notification,
          input.bodySha256,
          input.receivedAt,
        ),
        expectedClientStateDigest: watch.clientStateDigest,
        expectedResource: watch.resource,
        expectedSubscriptionId: watch.subscriptionId,
        notificationKind: notification.kind,
        projectId: watch.projectId,
        receivedAt: input.receivedAt,
        tenantId: watch.tenantId,
        watchId: watch.watchId,
      });
      if (outcome === 'ACCEPTED') accepted += 1;
      else if (outcome === 'DUPLICATE') duplicate += 1;
      else discarded += 1;
    }
    return { accepted, discarded, duplicate };
  }

  private matchesWatch(
    notification: SharePointNotification,
    watch: SharePointNotificationWatch | undefined,
  ): watch is SharePointNotificationWatch {
    if (
      watch === undefined ||
      notification.subscriptionId !== watch.subscriptionId ||
      notification.tenantId !== watch.externalTenantId ||
      !verifySharePointClientStateDigest(
        notification.clientState,
        watch.clientStateDigest,
      )
    ) {
      return false;
    }
    return (
      notification.kind === 'REAUTHORIZATION_REQUIRED' ||
      (notification.changeType === watch.changeType &&
        notification.resource === watch.resource)
    );
  }
}
