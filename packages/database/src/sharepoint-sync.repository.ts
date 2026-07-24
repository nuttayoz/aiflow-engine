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
  baseline_status: string;
  client_state_key_version: number | string;
  committed_delta_cursor_ciphertext: Buffer | null;
  connection_id: string;
  drive_id: string;
  inventory_generation: number | string;
  notification_generation: number | string;
  resource: string;
  scan_next_cursor_ciphertext: Buffer | null;
  subscription_expires_at: Date | string | null;
  subscription_id: string | null;
  subscription_status: string;
}

interface BindingRow {
  id: string;
  project_id: string;
  workflow_id: string;
  workflow_version_id: string;
}

interface PreviousItem {
  readonly kind: string;
  readonly parentId?: string;
  readonly sourceVersion?: string;
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
  private readonly workflows: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
    private readonly cursorProtector: SharePointCursorProtector,
    private readonly admission = {
      perConnection: 2,
      perTenant: 4,
    },
  ) {
    if (
      !Number.isInteger(admission.perConnection) ||
      !Number.isInteger(admission.perTenant) ||
      admission.perConnection < 1 ||
      admission.perTenant < admission.perConnection
    ) {
      throw new Error('SHAREPOINT_ADMISSION_CONFIGURATION_INVALID');
    }
    this.bindings = table(schema, 'connector_provisioning_bindings');
    this.ingestions = table(schema, 'document_ingestions');
    this.inbox = table(schema, 'inbox_messages');
    this.items = table(schema, 'sharepoint_drive_items');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.scopes = table(schema, 'sharepoint_binding_scopes');
    this.watches = table(schema, 'sharepoint_drive_watches');
    this.workflows = table(schema, 'workflows');
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
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 41002))',
        [input.tenantId],
      );
      const eligible = (await manager.query(
        `
          SELECT watch.connection_id
          FROM ${this.watches} AS watch
          WHERE watch.tenant_id = $1
            AND watch.id = $2
            AND watch.baseline_status IN ('COMPLETE', 'RECONCILING')
            AND watch.subscription_status IN ('ABSENT', 'ACTIVE', 'UNKNOWN')
            AND (
              watch.baseline_status = 'RECONCILING'
              OR watch.committed_delta_cursor_ciphertext IS NOT NULL
            )
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
          FOR UPDATE
        `,
        [input.tenantId, input.watchId, input.projectId],
      )) as { connection_id: string }[];
      if (eligible[0] === undefined) {
        await manager.query(
          `
            UPDATE ${this.inbox}
            SET outcome = 'STALE', completed_at = clock_timestamp()
            WHERE consumer_name = $1 AND message_id = $2
          `,
          [input.consumerName, input.messageId],
        );
        return undefined;
      }
      const running = (await manager.query(
        `
          SELECT
            count(*)::integer AS tenant_count,
            count(*) FILTER (
              WHERE connection_id = $2
            )::integer AS connection_count
          FROM ${this.watches}
          WHERE tenant_id = $1
            AND id <> $3
            AND lease_expires_at > clock_timestamp()
        `,
        [input.tenantId, eligible[0].connection_id, input.watchId],
      )) as {
        connection_count: number | string;
        tenant_count: number | string;
      }[];
      if (
        Number(running[0]?.tenant_count ?? 0) >= this.admission.perTenant ||
        Number(running[0]?.connection_count ?? 0) >=
          this.admission.perConnection
      ) {
        const deferred = mutationRows<{
          notification_generation: number | string;
          state_version: number | string;
        }>(
          await manager.query(
            `
              UPDATE ${this.watches}
              SET sync_command_pending = true,
                  state_version = state_version + 1,
                  next_reconcile_at = clock_timestamp() + interval '1 second',
                  failure_code = 'SHAREPOINT_ADMISSION_DEFERRED',
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND id = $2
              RETURNING state_version, notification_generation
            `,
            [input.tenantId, input.watchId],
          ),
        )[0];
        if (deferred !== undefined) {
          await this.appendSyncMessage(manager, {
            availableAt: new Date(Date.now() + 1_000),
            notificationGeneration: Number(deferred.notification_generation),
            projectId: input.projectId,
            stateVersion: Number(deferred.state_version),
            tenantId: input.tenantId,
            watchId: input.watchId,
          });
        }
        await manager.query(
          `
            UPDATE ${this.inbox}
            SET outcome = 'STALE', completed_at = clock_timestamp()
            WHERE consumer_name = $1 AND message_id = $2
          `,
          [input.consumerName, input.messageId],
        );
        return undefined;
      }

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
              AND watch.baseline_status IN ('COMPLETE', 'RECONCILING')
              AND watch.subscription_status IN ('ABSENT', 'ACTIVE', 'UNKNOWN')
              AND (
                watch.baseline_status = 'RECONCILING'
                OR watch.committed_delta_cursor_ciphertext IS NOT NULL
              )
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
              watch.baseline_status,
              watch.inventory_generation,
              watch.resource,
              watch.subscription_id,
              watch.subscription_status,
              watch.subscription_expires_at,
              watch.client_state_key_version,
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
      clientStateKeyVersion: Number(row.client_state_key_version),
      connectionId: row.connection_id,
      ...((row.scan_next_cursor_ciphertext ??
      row.committed_delta_cursor_ciphertext)
        ? {
            cursor: this.cursorProtector.unprotect(
              (row.scan_next_cursor_ciphertext ??
                row.committed_delta_cursor_ciphertext)!,
            ),
          }
        : {}),
      driveId: row.drive_id,
      inventoryGeneration: Number(row.inventory_generation),
      mode: row.baseline_status === 'RECONCILING' ? 'REBASELINE' : 'DELTA',
      notificationGeneration: Number(row.notification_generation),
      projectId: input.projectId,
      resource: row.resource,
      ...(row.subscription_expires_at === null
        ? {}
        : { subscriptionExpiresAt: new Date(row.subscription_expires_at) }),
      ...(row.subscription_id === null
        ? {}
        : { subscriptionId: row.subscription_id }),
      subscriptionStatus:
        row.subscription_status === 'UNKNOWN'
          ? 'UNKNOWN'
          : row.subscription_status === 'ABSENT'
            ? 'ABSENT'
            : 'ACTIVE',
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
              subscription_status = 'ACTIVE',
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

  async saveReconciledSubscription(
    input: Parameters<
      SharePointSyncRepository['saveReconciledSubscription']
    >[0],
  ): Promise<void> {
    const updated = mutationRows<{ id: string }>(
      await this.dataSource.query(
        `
          UPDATE ${this.watches}
          SET subscription_id = $4,
              subscription_expires_at = $5,
              subscription_status = 'ACTIVE',
              state_version = state_version + 1,
              failure_code = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = $2
            AND lease_owner = $3
            AND lease_expires_at > clock_timestamp()
            AND resource = $6
            AND change_type = $7
            AND client_state_digest = $8
          RETURNING id
        `,
        [
          input.tenantId,
          input.watchId,
          input.leaseOwner,
          input.subscription.id,
          input.subscription.expiresAt,
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
          SELECT
            baseline_status,
            inventory_generation,
            notification_generation
          FROM ${this.watches}
          WHERE tenant_id = $1
            AND id = $2
            AND lease_owner = $3
            AND lease_expires_at > clock_timestamp()
            AND baseline_status IN ('COMPLETE', 'RECONCILING')
          FOR UPDATE
        `,
        [input.claim.tenantId, input.claim.watchId, input.leaseOwner],
      )) as {
        baseline_status: string;
        inventory_generation: number | string;
        notification_generation: number | string;
      }[];
      const watch = watches[0];
      if (
        watch === undefined ||
        Number(watch.inventory_generation) !==
          input.claim.inventoryGeneration ||
        (watch.baseline_status === 'RECONCILING') !==
          (input.claim.mode === 'REBASELINE')
      ) {
        throw new Error('SHAREPOINT_SYNC_LEASE_LOST');
      }

      const previousItems = await this.findPreviousItems(
        manager,
        input.claim.tenantId,
        input.claim.watchId,
        input.items.map((item) => item.id),
      );
      for (const item of input.items) {
        await this.upsertItem(manager, input, item);
      }
      for (const item of input.items) {
        const previous = previousItems.get(item.id);
        if (
          item.kind === 'FILE' &&
          (input.claim.mode === 'DELTA' ||
            previous?.kind !== 'FILE' ||
            previous.sourceVersion !== (item.cTag ?? item.eTag) ||
            previous.parentId !== item.parentId)
        ) {
          await this.createIngestions(manager, input, item);
        }
        if (
          item.kind === 'FOLDER' &&
          (previous?.kind !== 'FOLDER' || previous.parentId !== item.parentId)
        ) {
          await this.createDescendantIngestions(manager, input, item.id);
        }
      }
      if (
        input.claim.mode === 'REBASELINE' &&
        input.finalCursor !== undefined
      ) {
        await manager.query(
          `
            UPDATE ${this.items}
            SET item_kind = 'DELETED',
                name = NULL,
                content_type = NULL,
                size_bytes = NULL,
                c_tag = NULL,
                e_tag = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND watch_id = $2
              AND last_observed_generation < $3
              AND item_kind <> 'DELETED'
          `,
          [
            input.claim.tenantId,
            input.claim.watchId,
            input.claim.inventoryGeneration,
          ],
        );
        await this.failInvalidScopes(manager, input);
      } else if (input.items.some((item) => item.kind === 'DELETED')) {
        await this.failInvalidScopes(manager, input);
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
            SET baseline_status = CASE
                  WHEN $8::boolean AND $4::boolean THEN 'COMPLETE'
                  ELSE baseline_status
                END,
                committed_delta_cursor_ciphertext = CASE
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
            input.claim.mode === 'REBASELINE',
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

  async resetCursor(
    input: Parameters<SharePointSyncRepository['resetCursor']>[0],
  ): Promise<void> {
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
            SET baseline_status = 'RECONCILING',
                inventory_generation = inventory_generation + 1,
                committed_delta_cursor_ciphertext = NULL,
                scan_next_cursor_ciphertext = NULL,
                sync_command_pending = $4,
                state_version = state_version + 1,
                next_reconcile_at = clock_timestamp(),
                lease_owner = NULL,
                lease_expires_at = NULL,
                failure_code = 'SHAREPOINT_DELTA_CURSOR_INVALID',
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
          ],
        ),
      )[0];
      if (updated === undefined) {
        throw new Error('SHAREPOINT_SYNC_LEASE_LOST');
      }
      if (projectId !== undefined) {
        await this.appendSyncMessage(manager, {
          availableAt: new Date(),
          notificationGeneration: Number(updated.notification_generation),
          projectId,
          stateVersion: Number(updated.state_version),
          tenantId: input.tenantId,
          watchId: input.watchId,
        });
      }
    });
  }

  private async findPreviousItems(
    manager: EntityManager,
    tenantId: string,
    watchId: string,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, PreviousItem>> {
    if (itemIds.length === 0) return new Map();
    const rows = (await manager.query(
      `
        SELECT
          item_id,
          item_kind,
          parent_item_id,
          COALESCE(c_tag, e_tag) AS source_version
        FROM ${this.items}
        WHERE tenant_id = $1
          AND watch_id = $2
          AND item_id = ANY($3::varchar[])
      `,
      [tenantId, watchId, itemIds],
    )) as {
      item_id: string;
      item_kind: string;
      parent_item_id: string | null;
      source_version: string | null;
    }[];
    return new Map(
      rows.map((row) => [
        row.item_id,
        {
          kind: row.item_kind,
          ...(row.parent_item_id === null
            ? {}
            : { parentId: row.parent_item_id }),
          ...(row.source_version === null
            ? {}
            : { sourceVersion: row.source_version }),
        },
      ]),
    );
  }

  private async createDescendantIngestions(
    manager: EntityManager,
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
    folderId: string,
  ): Promise<void> {
    const files = (await manager.query(
      `
        WITH RECURSIVE descendants AS (
          SELECT item.*, ARRAY[item.item_id]::varchar[] AS visited, 0 AS depth
          FROM ${this.items} AS item
          WHERE item.tenant_id = $1
            AND item.watch_id = $2
            AND item.item_id = $3
          UNION ALL
          SELECT
            child.*,
            parent.visited || child.item_id,
            parent.depth + 1
          FROM ${this.items} AS child
          JOIN descendants AS parent
            ON child.parent_item_id = parent.item_id
          WHERE child.tenant_id = $1 AND child.watch_id = $2
            AND parent.depth < 64
            AND NOT child.item_id = ANY(parent.visited)
        )
        SELECT
          item_id,
          parent_item_id,
          name,
          content_type,
          size_bytes,
          c_tag,
          e_tag
        FROM descendants
        WHERE item_kind = 'FILE'
          AND parent_item_id IS NOT NULL
          AND name IS NOT NULL
          AND size_bytes IS NOT NULL
          AND e_tag IS NOT NULL
      `,
      [input.claim.tenantId, input.claim.watchId, folderId],
    )) as {
      c_tag: string | null;
      content_type: string | null;
      e_tag: string;
      item_id: string;
      name: string;
      parent_item_id: string;
      size_bytes: number | string;
    }[];
    for (const file of files) {
      await this.createIngestions(manager, input, {
        ...(file.c_tag === null ? {} : { cTag: file.c_tag }),
        ...(file.content_type === null
          ? {}
          : { contentType: file.content_type }),
        eTag: file.e_tag,
        id: file.item_id,
        kind: 'FILE',
        name: file.name,
        parentId: file.parent_item_id,
        sizeBytes: Number(file.size_bytes),
      });
    }
  }

  private async failInvalidScopes(
    manager: EntityManager,
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
  ): Promise<void> {
    const failed = mutationRows<{ workflow_id: string }>(
      await manager.query(
        `
          UPDATE ${this.bindings} AS binding
          SET status = 'FAILED',
              health = 'DEGRADED',
              accepting_new_documents = false,
              failure_code = 'SHAREPOINT_SELECTED_FOLDER_UNAVAILABLE',
              state_version = state_version + 1,
              updated_at = clock_timestamp()
          FROM ${this.scopes} AS scope
          LEFT JOIN ${this.items} AS item
            ON item.tenant_id = scope.tenant_id
           AND item.watch_id = scope.watch_id
           AND item.item_id = scope.folder_id
          WHERE binding.tenant_id = $1
            AND scope.watch_id = $2
            AND scope.tenant_id = binding.tenant_id
            AND scope.binding_id = binding.id
            AND binding.status IN ('ACTIVE', 'DRAINING')
            AND (item.item_id IS NULL OR item.item_kind <> 'FOLDER')
          RETURNING binding.workflow_id
        `,
        [input.claim.tenantId, input.claim.watchId],
      ),
    );
    if (failed.length > 0) {
      await manager.query(
        `
          UPDATE ${this.workflows}
          SET accepting_new_documents = false,
              health = 'DEGRADED',
              state_version = state_version + 1,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
        `,
        [input.claim.tenantId, failed.map((row) => row.workflow_id)],
      );
    }
  }

  private async createIngestions(
    manager: EntityManager,
    input: Parameters<SharePointSyncRepository['applyDeltaPage']>[0],
    item: Extract<SharePointGraphItem, { kind: 'FILE' }>,
  ): Promise<void> {
    const bindings = (await manager.query(
      `
        WITH RECURSIVE ancestry AS (
          SELECT
            item_id,
            parent_item_id,
            ARRAY[item_id]::varchar[] AS visited,
            0 AS depth
          FROM ${this.items}
          WHERE tenant_id = $1 AND watch_id = $2 AND item_id = $3
          UNION ALL
          SELECT
            parent.item_id,
            parent.parent_item_id,
            child.visited || parent.item_id,
            child.depth + 1
          FROM ${this.items} AS parent
          JOIN ancestry AS child ON child.parent_item_id = parent.item_id
          WHERE parent.tenant_id = $1 AND parent.watch_id = $2
            AND child.depth < 64
            AND NOT parent.item_id = ANY(child.visited)
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
        input.claim.inventoryGeneration,
        input.observedAt,
      ],
    );
  }
}
