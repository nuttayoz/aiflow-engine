import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import type {
  RecordSharePointNotificationInput,
  RecordSharePointNotificationResult,
  SharePointNotificationRepository,
  SharePointNotificationWatch,
} from '@aiflow/connector-microsoft-sharepoint';
import { createMessageEnvelope } from '@aiflow/messaging';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface CallbackWatchRow {
  change_type: 'updated';
  client_state_digest: string;
  external_tenant_id: string;
  id: string;
  project_id: string;
  resource: string;
  subscription_id: string;
  tenant_id: string;
}

interface LockedWatchRow {
  notification_generation: number | string;
  state_version: number | string;
  sync_command_pending: boolean;
}

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

const mapWatch = (row: CallbackWatchRow): SharePointNotificationWatch => ({
  changeType: row.change_type,
  clientStateDigest: row.client_state_digest,
  externalTenantId: row.external_tenant_id,
  projectId: row.project_id,
  resource: row.resource,
  subscriptionId: row.subscription_id,
  tenantId: row.tenant_id,
  watchId: row.id,
});

const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);

export class PostgresSharePointRepository implements SharePointNotificationRepository {
  private readonly bindings: string;
  private readonly notificationEvents: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly scopes: string;
  private readonly watches: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.bindings = table(schema, 'connector_provisioning_bindings');
    this.notificationEvents = table(schema, 'sharepoint_notification_events');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.scopes = table(schema, 'sharepoint_binding_scopes');
    this.watches = table(schema, 'sharepoint_drive_watches');
  }

  async findWatchBySubscriptionId(
    subscriptionId: string,
  ): Promise<SharePointNotificationWatch | undefined> {
    if (subscriptionId.length === 0 || subscriptionId.length > 512) {
      return undefined;
    }
    const rows = (await this.dataSource.query(
      `
        SELECT
          watch.id,
          watch.tenant_id,
          watch.external_tenant_id,
          watch.resource,
          watch.change_type,
          watch.subscription_id,
          watch.client_state_digest,
          binding.project_id
        FROM ${this.watches} AS watch
        JOIN LATERAL (
          SELECT binding.project_id
          FROM ${this.scopes} AS scope
          JOIN ${this.bindings} AS binding
            ON binding.tenant_id = scope.tenant_id
           AND binding.id = scope.binding_id
          WHERE scope.tenant_id = watch.tenant_id
            AND scope.watch_id = watch.id
            AND binding.status IN ('PREPARING', 'ACTIVE', 'DRAINING')
          ORDER BY binding.created_at, binding.id
          LIMIT 1
        ) AS binding ON true
        WHERE watch.subscription_id = $1
          AND watch.subscription_status IN ('ACTIVE', 'RENEWING', 'UNKNOWN')
        LIMIT 1
      `,
      [subscriptionId],
    )) as CallbackWatchRow[];
    return rows[0] === undefined ? undefined : mapWatch(rows[0]);
  }

  async recordVerifiedNotification(
    input: RecordSharePointNotificationInput,
  ): Promise<RecordSharePointNotificationResult> {
    if (
      !isSha256(input.bodySha256) ||
      !isSha256(input.eventKeyHash) ||
      !isSha256(input.expectedClientStateDigest) ||
      !Number.isFinite(input.receivedAt.getTime())
    ) {
      throw new Error('SHAREPOINT_NOTIFICATION_RECORD_INVALID');
    }
    return this.dataSource.transaction(async (manager) => {
      const watches = (await manager.query(
        `
          SELECT
            watch.notification_generation,
            watch.state_version,
            watch.sync_command_pending
          FROM ${this.watches} AS watch
          WHERE watch.tenant_id = $1
            AND watch.id = $2
            AND watch.subscription_id = $3
            AND watch.client_state_digest = $4
            AND watch.resource = $5
            AND watch.subscription_status IN ('ACTIVE', 'RENEWING', 'UNKNOWN')
            AND EXISTS (
              SELECT 1
              FROM ${this.scopes} AS scope
              JOIN ${this.bindings} AS binding
                ON binding.tenant_id = scope.tenant_id
               AND binding.id = scope.binding_id
              WHERE scope.tenant_id = watch.tenant_id
                AND scope.watch_id = watch.id
                AND binding.project_id = $6
                AND binding.status IN ('PREPARING', 'ACTIVE', 'DRAINING')
            )
          FOR UPDATE
        `,
        [
          input.tenantId,
          input.watchId,
          input.expectedSubscriptionId,
          input.expectedClientStateDigest,
          input.expectedResource,
          input.projectId,
        ],
      )) as LockedWatchRow[];
      const watch = watches[0];
      if (watch === undefined) return 'STALE';

      const expiresAt = new Date(
        input.receivedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
      );
      const inserted = mutationRows<{ id: string }>(
        await manager.query(
          `
            INSERT INTO ${this.notificationEvents} (
              id,
              tenant_id,
              watch_id,
              event_key_hash,
              body_sha256,
              notification_kind,
              received_at,
              expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (tenant_id, watch_id, event_key_hash) DO NOTHING
            RETURNING id
          `,
          [
            randomUUID(),
            input.tenantId,
            input.watchId,
            input.eventKeyHash,
            input.bodySha256,
            input.notificationKind,
            input.receivedAt,
            expiresAt,
          ],
        ),
      );
      if (inserted.length === 0) return 'DUPLICATE';

      const updated = mutationRows<{
        notification_generation: number | string;
        state_version: number | string;
      }>(
        await manager.query(
          `
            UPDATE ${this.watches}
            SET notification_generation = notification_generation + 1,
                sync_command_pending = true,
                state_version = state_version + 1,
                next_reconcile_at = LEAST(next_reconcile_at, $3),
                last_notification_at = $3,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2
            RETURNING notification_generation, state_version
          `,
          [input.tenantId, input.watchId, input.receivedAt],
        ),
      )[0];
      if (updated === undefined) {
        throw new Error('SHAREPOINT_NOTIFICATION_WATCH_UPDATE_FAILED');
      }

      if (!watch.sync_command_pending) {
        const envelope = createMessageEnvelope({
          actor: { id: 'microsoft-sharepoint-callback', type: 'SERVICE' },
          causationId: input.eventKeyHash,
          correlationId: input.eventKeyHash,
          data: {
            expectedNotificationGeneration: Number(
              updated.notification_generation,
            ),
            expectedStateVersion: Number(updated.state_version),
            watchId: input.watchId,
          },
          occurredAt: input.receivedAt,
          projectId: input.projectId,
          tenantId: input.tenantId,
          type: 'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
        });
        await this.outbox.append(queryRunner(manager), {
          aggregateId: input.watchId,
          aggregateType: 'SHAREPOINT_DRIVE_WATCH',
          envelope,
        });
      }
      return 'ACCEPTED';
    });
  }
}
