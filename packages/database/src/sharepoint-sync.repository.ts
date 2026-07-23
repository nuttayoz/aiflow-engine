import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  sharePointClientStateDigest,
  type SharePointCursorProtector,
  type SharePointGraphItem,
  type SharePointSyncClaim,
  type SharePointSyncRepository,
} from '@aiflow/connector-microsoft-sharepoint';
import { createMessageEnvelope } from '@aiflow/messaging';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface SyncClaimRow {
  committed_delta_cursor_ciphertext: Buffer;
  connection_id: string;
  drive_id: string;
  notification_generation: number | string;
  resource: string;
  scan_next_cursor_ciphertext: Buffer | null;
  subscription_expires_at: Date | string;
  subscription_id: string;
}

interface BindingRow {
  id: string;
  project_id: string;
  workflow_id: string;
  workflow_version_id: string;
}

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

const isBounded = (value: string | undefined, maximumLength: number): boolean =>
  value === undefined || (value.length > 0 && value.length <= maximumLength);

export class PostgresSharePointSyncRepository implements SharePointSyncRepository {
  private readonly bindings: string;
  private readonly ingestions: string;
  private readonly inbox: string;
  private readonly items: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly scopes: string;
  private readonly watches: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
    private readonly cursorProtector: SharePointCursorProtector,
  ) {
    this.bindings = table(schema, 'connector_provisioning_bindings');
    this.ingestions = table(schema, 'document_ingestions');
    this.inbox = table(schema, 'inbox_messages');
    this.items = table(schema, 'sharepoint_drive_items');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.scopes = table(schema, 'sharepoint_binding_scopes');
    this.watches = table(schema, 'sharepoint_drive_watches');
  }

  async claim(
    input: Parameters<SharePointSyncRepository['claim']>[0],
  ): Promise<SharePointSyncClaim | undefined> {
    if (
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 300_000
    ) {
      throw new Error('LEASE_DURATION_INVALID');
    }
    const row = await this.dataSource.transaction(async (manager) => {
      const inbox = mutationRows<{ id: string }>(
        await manager.query(
          `
            INSERT INTO ${this.inbox} (
              id,
              consumer_name,
              message_id,
              message_type,
              tenant_id,
              project_id,
              target_type,
              target_id,
              outcome,
              expires_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              'SHAREPOINT_DRIVE_WATCH', $7, 'CLAIMED',
              clock_timestamp() + interval '30 days'
            )
            ON CONFLICT (consumer_name, message_id) DO NOTHING
            RETURNING id
          `,
          [
            randomUUID(),
            input.consumerName,
            input.messageId,
            input.messageType,
            input.tenantId,
            input.projectId,
            input.watchId,
          ],
        ),
      );
      if (inbox.length === 0) return undefined;

      const rows = mutationRows<SyncClaimRow>(
        await manager.query(
          `
            UPDATE ${this.watches} AS watch
            SET lease_owner = $4,
                lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'),
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE watch.tenant_id = $1
              AND watch.id = $2
              AND watch.baseline_status = 'COMPLETE'
              AND watch.subscription_status = 'ACTIVE'
              AND watch.subscription_id IS NOT NULL
              AND watch.subscription_expires_at IS NOT NULL
              AND watch.committed_delta_cursor_ciphertext IS NOT NULL
              AND (
                watch.sync_command_pending
                OR watch.next_reconcile_at <= clock_timestamp()
              )
              AND (
                watch.lease_expires_at IS NULL
                OR watch.lease_expires_at <= clock_timestamp()
              )
              AND EXISTS (
                SELECT 1
                FROM ${this.scopes} AS scope
                JOIN ${this.bindings} AS binding
                  ON binding.tenant_id = scope.tenant_id
                 AND binding.id = scope.binding_id
                WHERE scope.tenant_id = watch.tenant_id
                  AND scope.watch_id = watch.id
                  AND binding.project_id = $3
                  AND binding.status IN ('ACTIVE', 'DRAINING')
                  AND binding.accepting_new_documents
              )
            RETURNING
              watch.connection_id,
              watch.drive_id,
              watch.resource,
              watch.subscription_id,
              watch.subscription_expires_at,
              watch.notification_generation,
              watch.committed_delta_cursor_ciphertext,
              watch.scan_next_cursor_ciphertext
          `,
          [
            input.tenantId,
            input.watchId,
            input.projectId,
            input.leaseOwner,
            input.leaseDurationMs,
          ],
        ),
      );
      if (rows[0] === undefined) {
        await manager.query(
          `
            UPDATE ${this.inbox}
            SET outcome = 'STALE'
            WHERE consumer_name = $1 AND message_id = $2
          `,
          [input.consumerName, input.messageId],
        );
      }
      return rows[0];
    });
    if (row === undefined) return undefined;
    return {
      connectionId: row.connection_id,
      cursor: this.cursorProtector.unprotect(
        row.scan_next_cursor_ciphertext ??
          row.committed_delta_cursor_ciphertext,
      ),
      driveId: row.drive_id,
      notificationGeneration: Number(row.notification_generation),
      projectId: input.projectId,
      resource: row.resource,
      subscriptionExpiresAt: new Date(row.subscription_expires_at),
      subscriptionId: row.subscription_id,
      tenantId: input.tenantId,
      watchId: input.watchId,
    };
  }

  async saveRenewedSubscription(
    input: Parameters<SharePointSyncRepository['saveRenewedSubscription']>[0],
  ): Promise<void> {
    const updated = mutationRows<{ id: string }>(
      await this.dataSource.query(
        `
          UPDATE ${this.watches}
          SET subscription_expires_at = $4,
              state_version = state_version + 1,
              failure_code = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = $2
            AND lease_owner = $3
            AND lease_expires_at > clock_timestamp()
            AND subscription_id = $5
            AND resource = $6
            AND change_type = $7
            AND client_state_digest = $8
          RETURNING id
        `,
        [
          input.tenantId,
          input.watchId,
          input.leaseOwner,
          input.subscription.expiresAt,
          input.subscription.id,
          input.subscription.resource,
          input.subscription.changeType,
          sharePointClientStateDigest(input.subscription.clientState),
        ],
      ),
    );
    if (updated.length !== 1) {
      throw new Error('SHAREPOINT_SYNC_LEASE_LOST');
    }
  }

  async applyDeltaPage(
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
  ): Promise<void> {
    if (
      input.items.length > 1_000 ||
      new Set(input.items.map((item) => item.id)).size !== input.items.length ||
      (input.nextCursor === undefined) === (input.finalCursor === undefined)
    ) {
      throw new Error('SHAREPOINT_DELTA_PAGE_INVALID');
    }
    for (const item of input.items) this.assertItem(item);
    const nextCiphertext =
      input.nextCursor === undefined
        ? undefined
        : this.cursorProtector.protect(input.nextCursor);
    const finalCiphertext =
      input.finalCursor === undefined
        ? undefined
        : this.cursorProtector.protect(input.finalCursor);

    await this.dataSource.transaction(async (manager) => {
      const watches = (await manager.query(
        `
          SELECT notification_generation
          FROM ${this.watches}
          WHERE tenant_id = $1
            AND id = $2
            AND lease_owner = $3
            AND lease_expires_at > clock_timestamp()
            AND baseline_status = 'COMPLETE'
          FOR UPDATE
        `,
        [input.claim.tenantId, input.claim.watchId, input.leaseOwner],
      )) as { notification_generation: number | string }[];
      const watch = watches[0];
      if (watch === undefined) {
        throw new Error('SHAREPOINT_SYNC_LEASE_LOST');
      }

      for (const item of input.items) {
        await this.upsertItem(manager, input, item);
      }
      for (const item of input.items) {
        if (item.kind === 'FILE') {
          await this.createIngestions(manager, input, item);
        }
      }

      const projectId = await this.findProjectId(
        manager,
        input.claim.tenantId,
        input.claim.watchId,
      );
      const notificationGeneration = Number(watch.notification_generation);
      const needsFollowUp =
        projectId !== undefined &&
        (input.nextCursor !== undefined ||
          notificationGeneration !== input.claim.notificationGeneration);
      const updated = mutationRows<{
        notification_generation: number | string;
        state_version: number | string;
      }>(
        await manager.query(
          `
            UPDATE ${this.watches}
            SET committed_delta_cursor_ciphertext = CASE
                  WHEN $4::boolean THEN $5
                  ELSE committed_delta_cursor_ciphertext
                END,
                scan_next_cursor_ciphertext = $6,
                sync_command_pending = $7,
                state_version = state_version + 1,
                next_reconcile_at = CASE
                  WHEN $7::boolean THEN clock_timestamp()
                  ELSE clock_timestamp() + interval '15 minutes'
                END,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_reconciled_at = clock_timestamp(),
                failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3
            RETURNING state_version, notification_generation
          `,
          [
            input.claim.tenantId,
            input.claim.watchId,
            input.leaseOwner,
            input.finalCursor !== undefined,
            finalCiphertext === undefined ? null : Buffer.from(finalCiphertext),
            nextCiphertext === undefined ? null : Buffer.from(nextCiphertext),
            needsFollowUp,
          ],
        ),
      )[0];
      if (updated === undefined) {
        throw new Error('SHAREPOINT_SYNC_LEASE_LOST');
      }
      if (needsFollowUp && projectId !== undefined) {
        await this.appendSyncMessage(manager, {
          availableAt: input.observedAt,
          notificationGeneration: Number(updated.notification_generation),
          projectId,
          stateVersion: Number(updated.state_version),
          tenantId: input.claim.tenantId,
          watchId: input.claim.watchId,
        });
      }
    });
  }

  async defer(
    input: Parameters<SharePointSyncRepository['defer']>[0],
  ): Promise<void> {
    if (
      !Number.isFinite(input.retryAt.getTime()) ||
      input.retryAt.getTime() <= Date.now() ||
      input.retryAt.getTime() > Date.now() + 24 * 60 * 60 * 1_000
    ) {
      throw new Error('SHAREPOINT_SYNC_RETRY_AT_INVALID');
    }
    await this.dataSource.transaction(async (manager) => {
      const projectId = await this.findProjectId(
        manager,
        input.tenantId,
        input.watchId,
      );
      const updated = mutationRows<{
        notification_generation: number | string;
        state_version: number | string;
      }>(
        await manager.query(
          `
            UPDATE ${this.watches}
            SET sync_command_pending = $4,
                state_version = state_version + 1,
                next_reconcile_at = $5,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND lease_owner = $3
              AND lease_expires_at > clock_timestamp()
            RETURNING state_version, notification_generation
          `,
          [
            input.tenantId,
            input.watchId,
            input.leaseOwner,
            projectId !== undefined,
            input.retryAt,
          ],
        ),
      )[0];
      if (updated === undefined) {
        throw new Error('SHAREPOINT_SYNC_LEASE_LOST');
      }
      if (projectId !== undefined) {
        await this.appendSyncMessage(manager, {
          availableAt: input.retryAt,
          notificationGeneration: Number(updated.notification_generation),
          projectId,
          stateVersion: Number(updated.state_version),
          tenantId: input.tenantId,
          watchId: input.watchId,
        });
      }
    });
  }

  private async createIngestions(
    manager: EntityManager,
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
    item: Extract<SharePointGraphItem, { kind: 'FILE' }>,
  ): Promise<void> {
    const bindings = (await manager.query(
      `
        WITH RECURSIVE ancestry AS (
          SELECT item_id, parent_item_id
          FROM ${this.items}
          WHERE tenant_id = $1 AND watch_id = $2 AND item_id = $3
          UNION ALL
          SELECT parent.item_id, parent.parent_item_id
          FROM ${this.items} AS parent
          JOIN ancestry AS child ON child.parent_item_id = parent.item_id
          WHERE parent.tenant_id = $1 AND parent.watch_id = $2
        )
        SELECT
          binding.id,
          binding.project_id,
          binding.workflow_id,
          binding.workflow_version_id
        FROM ${this.scopes} AS scope
        JOIN ${this.bindings} AS binding
          ON binding.tenant_id = scope.tenant_id
         AND binding.id = scope.binding_id
        WHERE scope.tenant_id = $1
          AND scope.watch_id = $2
          AND binding.status IN ('ACTIVE', 'DRAINING')
          AND binding.accepting_new_documents
          AND (
            scope.folder_id = $4
            OR (
              scope.include_subfolders
              AND EXISTS (
                SELECT 1
                FROM ancestry
                WHERE ancestry.item_id = scope.folder_id
              )
            )
          )
        ORDER BY binding.id
      `,
      [input.claim.tenantId, input.claim.watchId, item.id, item.parentId],
    )) as BindingRow[];
    const sourceVersionKind = item.cTag === undefined ? 'ETAG' : 'CTAG';
    const sourceVersion = item.cTag ?? item.eTag;
    for (const binding of bindings) {
      const ingestionId = randomUUID();
      const inserted = mutationRows<{ id: string }>(
        await manager.query(
          `
            INSERT INTO ${this.ingestions} (
              id,
              tenant_id,
              project_id,
              connector_provisioning_binding_id,
              watch_id,
              workflow_id,
              workflow_version_id,
              connector_id,
              drive_id,
              item_id,
              source_version_kind,
              source_version,
              next_attempt_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              'microsoft-sharepoint', $8, $9, $10, $11,
              clock_timestamp()
            )
            ON CONFLICT (
              tenant_id,
              connector_provisioning_binding_id,
              drive_id,
              item_id,
              source_version_kind,
              source_version
            ) DO NOTHING
            RETURNING id
          `,
          [
            ingestionId,
            input.claim.tenantId,
            binding.project_id,
            binding.id,
            input.claim.watchId,
            binding.workflow_id,
            binding.workflow_version_id,
            input.claim.driveId,
            item.id,
            sourceVersionKind,
            sourceVersion,
          ],
        ),
      );
      if (inserted.length === 1) {
        const envelope = createMessageEnvelope({
          actor: { id: 'microsoft-sharepoint-sync', type: 'SERVICE' },
          causationId: ingestionId,
          correlationId: input.claim.watchId,
          data: {
            connectorId: 'microsoft-sharepoint',
            expectedStateVersion: 0,
            ingestionId,
          },
          occurredAt: input.observedAt,
          projectId: binding.project_id,
          tenantId: input.claim.tenantId,
          type: 'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
        });
        await this.outbox.append(queryRunner(manager), {
          aggregateId: ingestionId,
          aggregateType: 'DOCUMENT_INGESTION',
          envelope,
        });
      }
    }
  }

  private async findProjectId(
    manager: EntityManager,
    tenantId: string,
    watchId: string,
  ): Promise<string | undefined> {
    const rows = (await manager.query(
      `
        SELECT binding.project_id
        FROM ${this.scopes} AS scope
        JOIN ${this.bindings} AS binding
          ON binding.tenant_id = scope.tenant_id
         AND binding.id = scope.binding_id
        WHERE scope.tenant_id = $1
          AND scope.watch_id = $2
          AND binding.status IN ('ACTIVE', 'DRAINING')
          AND binding.accepting_new_documents
        ORDER BY binding.created_at, binding.id
        LIMIT 1
      `,
      [tenantId, watchId],
    )) as { project_id: string }[];
    return rows[0]?.project_id;
  }

  private async appendSyncMessage(
    manager: EntityManager,
    input: {
      readonly availableAt: Date;
      readonly notificationGeneration: number;
      readonly projectId: string;
      readonly stateVersion: number;
      readonly tenantId: string;
      readonly watchId: string;
    },
  ): Promise<void> {
    const envelope = createMessageEnvelope({
      actor: { id: 'microsoft-sharepoint-sync', type: 'SERVICE' },
      causationId: input.watchId,
      correlationId: input.watchId,
      data: {
        expectedNotificationGeneration: input.notificationGeneration,
        expectedStateVersion: input.stateVersion,
        watchId: input.watchId,
      },
      occurredAt: input.availableAt,
      projectId: input.projectId,
      tenantId: input.tenantId,
      type: 'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
    });
    await this.outbox.append(queryRunner(manager), {
      aggregateId: input.watchId,
      aggregateType: 'SHAREPOINT_DRIVE_WATCH',
      availableAt: input.availableAt,
      envelope,
    });
  }

  private assertItem(item: SharePointGraphItem): void {
    if (
      !isBounded(item.id, 512) ||
      !isBounded(item.parentId, 512) ||
      (item.kind !== 'DELETED' &&
        (!isBounded(item.name, 512) || !isBounded(item.eTag, 512))) ||
      (item.kind === 'FILE' &&
        (!Number.isSafeInteger(item.sizeBytes) ||
          item.sizeBytes < 0 ||
          !isBounded(item.cTag, 512) ||
          !isBounded(item.contentType, 255)))
    ) {
      throw new Error('SHAREPOINT_DELTA_ITEM_INVALID');
    }
  }

  private async upsertItem(
    manager: EntityManager,
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
    item: SharePointGraphItem,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO ${this.items} (
          tenant_id,
          watch_id,
          item_id,
          parent_item_id,
          item_kind,
          name,
          content_type,
          size_bytes,
          c_tag,
          e_tag,
          last_observed_generation,
          observed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
        ON CONFLICT (tenant_id, watch_id, item_id) DO UPDATE
        SET parent_item_id = EXCLUDED.parent_item_id,
            item_kind = EXCLUDED.item_kind,
            name = EXCLUDED.name,
            content_type = EXCLUDED.content_type,
            size_bytes = EXCLUDED.size_bytes,
            c_tag = EXCLUDED.c_tag,
            e_tag = EXCLUDED.e_tag,
            last_observed_generation = EXCLUDED.last_observed_generation,
            observed_at = EXCLUDED.observed_at,
            updated_at = clock_timestamp()
      `,
      [
        input.claim.tenantId,
        input.claim.watchId,
        item.id,
        item.parentId ?? null,
        item.kind,
        item.kind === 'DELETED' ? null : item.name,
        item.kind === 'FILE' ? (item.contentType ?? null) : null,
        item.kind === 'FILE' ? item.sizeBytes : null,
        item.kind === 'FILE' ? (item.cTag ?? null) : null,
        item.kind === 'DELETED' ? null : item.eTag,
        input.claim.notificationGeneration,
        input.observedAt,
      ],
    );
  }
}
