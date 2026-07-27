import {
  deriveSharePointClientState,
  parseSharePointNotificationCollection,
  type RecordSharePointNotificationInput,
  type RecordSharePointNotificationResult,
  type SharePointNotificationRepository,
  SharePointNotificationIntake,
  sharePointClientStateDigest,
  validateSharePointValidationToken,
} from './index';

const clientState = deriveSharePointClientState('watch-1', {
  keyVersion: 1,
  rootKey: new Uint8Array(32).fill(3),
});

class NotificationRepository implements SharePointNotificationRepository {
  readonly records: RecordSharePointNotificationInput[] = [];
  result: RecordSharePointNotificationResult = 'ACCEPTED';

  async findWatchBySubscriptionId(subscriptionId: string) {
    if (subscriptionId !== 'subscription-1') return undefined;
    return {
      changeType: 'updated' as const,
      clientStateDigest: sharePointClientStateDigest(clientState),
      externalTenantId: 'external-tenant-1',
      projectId: 'project-1',
      resource: 'drives/drive-1/root',
      subscriptionId,
      tenantId: 'engine-tenant-1',
      watchId: 'watch-1',
    };
  }

  async recordVerifiedNotification(input: RecordSharePointNotificationInput) {
    this.records.push(input);
    return this.result;
  }
}

const changeNotification = {
  changeType: 'updated',
  clientState,
  id: 'notification-1',
  resource: 'drives/drive-1/root',
  resourceData: {
    '@odata.type': '#microsoft.graph.driveItem',
    id: 'root-1',
  },
  subscriptionExpirationDateTime: '2026-08-20T00:00:00.000Z',
  subscriptionId: 'subscription-1',
  tenantId: 'external-tenant-1',
};

describe('SharePoint notification boundary', () => {
  it('accepts a verified basic notification and discards resource data', async () => {
    const repository = new NotificationRepository();
    const intake = new SharePointNotificationIntake(repository);

    await expect(
      intake.accept({
        body: { value: [changeNotification] },
        bodySha256: 'a'.repeat(64),
        receivedAt: new Date('2026-07-23T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ accepted: 1, discarded: 0, duplicate: 0 });
    expect(repository.records).toEqual([
      expect.objectContaining({
        eventKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        notificationKind: 'CHANGE',
        watchId: 'watch-1',
      }),
    ]);
    expect(JSON.stringify(repository.records)).not.toContain('resourceData');
  });

  it('uniformly discards an unknown subscription or invalid client state', async () => {
    const repository = new NotificationRepository();
    const intake = new SharePointNotificationIntake(repository);

    await expect(
      intake.accept({
        body: {
          value: [
            { ...changeNotification, subscriptionId: 'unknown' },
            { ...changeNotification, clientState: 'invalid' },
          ],
        },
        bodySha256: 'b'.repeat(64),
        receivedAt: new Date(),
      }),
    ).resolves.toEqual({ accepted: 0, discarded: 2, duplicate: 0 });
    expect(repository.records).toEqual([]);
  });

  it('accepts only the supported lifecycle event shape', () => {
    expect(
      parseSharePointNotificationCollection({
        value: [
          {
            clientState,
            lifecycleEvent: 'reauthorizationRequired',
            subscriptionId: 'subscription-1',
            tenantId: 'external-tenant-1',
          },
        ],
      }),
    ).toEqual([expect.objectContaining({ kind: 'REAUTHORIZATION_REQUIRED' })]);
    expect(() =>
      parseSharePointNotificationCollection({
        value: [
          {
            clientState,
            lifecycleEvent: 'missed',
            subscriptionId: 'subscription-1',
            tenantId: 'external-tenant-1',
          },
        ],
      }),
    ).toThrow('SHAREPOINT_NOTIFICATION_INVALID');
  });

  it('rejects unbounded collections and encrypted resource content', () => {
    expect(() =>
      parseSharePointNotificationCollection({
        value: Array.from({ length: 101 }, () => changeNotification),
      }),
    ).toThrow('SHAREPOINT_NOTIFICATION_INVALID');
    expect(() =>
      parseSharePointNotificationCollection({
        value: [{ ...changeNotification, encryptedContent: {} }],
      }),
    ).toThrow('SHAREPOINT_NOTIFICATION_INVALID');
  });

  it('echoes only a bounded validation token', () => {
    expect(validateSharePointValidationToken('opaque validation token')).toBe(
      'opaque validation token',
    );
    expect(() => validateSharePointValidationToken(['duplicate'])).toThrow(
      'SHAREPOINT_VALIDATION_TOKEN_INVALID',
    );
    expect(() => validateSharePointValidationToken('x'.repeat(4_097))).toThrow(
      'SHAREPOINT_VALIDATION_TOKEN_INVALID',
    );
  });
});
