import type { DataSource, EntityManager } from 'typeorm';

import {
  sharePointClientStateDigest,
  type SharePointCursorProtector,
  type SharePointGraphItem,
  type SharePointProvisioningRepository,
  type SharePointProvisioningState,
} from '@aiflow/connector-microsoft-sharepoint';

import { mutationRows, table } from './sql';

interface ProvisioningStateRow {
  baseline_status: string;
  binding_id: string;
  client_state_digest: string;
  client_state_key_version: number | string;
  committed_delta_cursor_ciphertext: Buffer | null;
  connection_id: string;
  drive_id: string;
  external_tenant_id: string;
  resource: string;
  scan_next_cursor_ciphertext: Buffer | null;
  site_id: string;
  state_version: number | string;
  subscription_expires_at: Date | string | null;
  subscription_id: string | null;
  subscription_status: string;
  tenant_id: string;
  watch_id: string;
}

interface WatchIdentityRow {
  client_state_digest: string;
  drive_id: string;
  external_tenant_id: string;
  id: string;
  resource: string;
  root_item_id: string;
  site_id: string;
}

const baselineStatus = (
  value: string,
): SharePointProvisioningState['baselineStatus'] => {
  if (['PENDING', 'RUNNING', 'COMPLETE', 'FAILED'].includes(value)) {
    return value as SharePointProvisioningState['baselineStatus'];
  }
  return value === 'RECONCILING' ? 'RUNNING' : 'FAILED';
};

const subscriptionStatus = (
  value: string,
): SharePointProvisioningState['subscriptionStatus'] => {
  if (['ABSENT', 'ACTIVE', 'FAILED', 'UNKNOWN'].includes(value)) {
    return value as SharePointProvisioningState['subscriptionStatus'];
  }
  return 'UNKNOWN';
};

const isBounded = (value: string | undefined, maximumLength: number): boolean =>
  value === undefined || (value.length > 0 && value.length <= maximumLength);

export class PostgresSharePointProvisioningRepository implements SharePointProvisioningRepository {
  private readonly bindings: string;
  private readonly ingestions: string;
  private readonly items: string;
  private readonly scopes: string;
  private readonly watches: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
    private readonly cursorProtector: SharePointCursorProtector,
  ) {
    this.bindings = table(schema, 'connector_provisioning_bindings');
    this.ingestions = table(schema, 'document_ingestions');
    this.items = table(schema, 'sharepoint_drive_items');
    this.scopes = table(schema, 'sharepoint_binding_scopes');
    this.watches = table(schema, 'sharepoint_drive_watches');
  }

  async beginRemoval(
    input: Parameters<SharePointProvisioningRepository['beginRemoval']>[0],
  ) {
    return this.dataSource.transaction(async (manager) => {
      const bindings = (await manager.query(
        `
          SELECT
            binding.id AS binding_id,
            binding.connection_id,
            watch.id AS watch_id,
            watch.subscription_id
          FROM ${this.bindings} AS binding
          JOIN ${this.scopes} AS scope
            ON scope.tenant_id = binding.tenant_id
           AND scope.binding_id = binding.id
          JOIN ${this.watches} AS watch
            ON watch.tenant_id = scope.tenant_id
           AND watch.id = scope.watch_id
          WHERE binding.tenant_id = $1
            AND binding.project_id = $2
            AND binding.workflow_id = $3
            AND binding.workflow_version_id = $4
            AND binding.connector_id = 'microsoft-sharepoint'
            AND binding.status IN ('ACTIVE', 'DRAINING')
          FOR UPDATE OF binding, watch
        `,
        [
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.workflowVersionId,
        ],
      )) as {
        binding_id: string;
        connection_id: string;
        subscription_id: string | null;
        watch_id: string;
      }[];
      const binding = bindings[0];
      if (binding === undefined) {
        throw new Error('SHAREPOINT_BINDING_NOT_FOUND');
      }
      await manager.query(
        `
          UPDATE ${this.bindings}
          SET status = 'DRAINING',
              accepting_new_documents = false,
              drain_deadline_at = COALESCE(
                drain_deadline_at,
                clock_timestamp() + interval '15 minutes'
              ),
              state_version = state_version + 1,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2
        `,
        [input.tenantId, binding.binding_id],
      );
      const references = (await manager.query(
        `
          SELECT count(*)::integer AS count
          FROM ${this.scopes} AS scope
          JOIN ${this.bindings} AS candidate
            ON candidate.tenant_id = scope.tenant_id
           AND candidate.id = scope.binding_id
          WHERE scope.tenant_id = $1
            AND scope.watch_id = $2
            AND candidate.id <> $3
            AND candidate.status IN ('PREPARING', 'ACTIVE')
        `,
        [input.tenantId, binding.watch_id, binding.binding_id],
      )) as { count: number | string }[];
      const pending = (await manager.query(
        `
          SELECT count(*)::integer AS count
          FROM ${this.ingestions}
          WHERE tenant_id = $1
            AND connector_provisioning_binding_id = $2
            AND status IN ('PENDING', 'RUNNING', 'WAITING_RETRY')
        `,
        [input.tenantId, binding.binding_id],
      )) as { count: number | string }[];
      return {
        bindingId: binding.binding_id,
        connectionId: binding.connection_id,
        hasPendingIngestions: Number(pending[0]?.count ?? 0) > 0,
        lastWatchReference: Number(references[0]?.count ?? 0) === 0,
        ...(binding.subscription_id === null
          ? {}
          : { subscriptionId: binding.subscription_id }),
        tenantId: input.tenantId,
        watchId: binding.watch_id,
      };
    });
  }

  async finishRemoval(
    input: Parameters<SharePointProvisioningRepository['finishRemoval']>[0],
  ) {
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT binding.id
          FROM ${this.bindings} AS binding
          JOIN ${this.scopes} AS scope
            ON scope.tenant_id = binding.tenant_id
           AND scope.binding_id = binding.id
          JOIN ${this.watches} AS watch
            ON watch.tenant_id = scope.tenant_id
           AND watch.id = scope.watch_id
          WHERE binding.tenant_id = $1
            AND binding.id = $2
            AND watch.id = $3
            AND binding.status = 'DRAINING'
          FOR UPDATE OF binding, watch
        `,
        [input.tenantId, input.bindingId, input.watchId],
      )) as { id: string }[];
      if (rows.length !== 1) {
        throw new Error('SHAREPOINT_REMOVAL_STATE_CONFLICT');
      }
      const references = (await manager.query(
        `
          SELECT count(*)::integer AS count
          FROM ${this.scopes} AS scope
          JOIN ${this.bindings} AS binding
            ON binding.tenant_id = scope.tenant_id
           AND binding.id = scope.binding_id
          WHERE scope.tenant_id = $1
            AND scope.watch_id = $2
            AND binding.id <> $3
            AND binding.status IN ('PREPARING', 'ACTIVE')
        `,
        [input.tenantId, input.watchId, input.bindingId],
      )) as { count: number | string }[];
      const lastReference = Number(references[0]?.count ?? 0) === 0;
      if (input.subscriptionAbsent) {
        await manager.query(
          `
            UPDATE ${this.watches}
            SET subscription_id = NULL,
                subscription_expires_at = NULL,
                subscription_status = 'ABSENT',
                health = CASE WHEN $3 THEN 'UNKNOWN' ELSE 'DEGRADED' END,
                sync_command_pending = NOT $3,
                next_reconcile_at = clock_timestamp(),
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2
          `,
          [input.tenantId, input.watchId, lastReference],
        );
      }
      if (lastReference && !input.subscriptionAbsent) {
        return { complete: false };
      }
      const pending = (await manager.query(
        `
          SELECT count(*)::integer AS count
          FROM ${this.ingestions}
          WHERE tenant_id = $1
            AND connector_provisioning_binding_id = $2
            AND status IN ('PENDING', 'RUNNING', 'WAITING_RETRY')
        `,
        [input.tenantId, input.bindingId],
      )) as { count: number | string }[];
      if (Number(pending[0]?.count ?? 0) > 0) {
        return { complete: false };
      }
      const retired = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.bindings}
            SET status = 'RETIRED',
                health = 'UNKNOWN',
                accepting_new_documents = false,
                drain_deadline_at = NULL,
                retired_at = clock_timestamp(),
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND status = 'DRAINING'
            RETURNING id
          `,
          [input.tenantId, input.bindingId],
        ),
      );
      if (retired.length !== 1) {
        throw new Error('SHAREPOINT_REMOVAL_STATE_CONFLICT');
      }
      return { complete: true };
    });
  }

  async ensureBindingAndWatch(
    input: Parameters<
      SharePointProvisioningRepository['ensureBindingAndWatch']
    >[0],
  ): Promise<SharePointProvisioningState> {
    return this.dataSource.transaction(async (manager) => {
      const existingBindings = (await manager.query(
        `
          SELECT
            binding.id,
            binding.capability_hash,
            binding.configuration_hash,
            binding.connection_id,
            scope.site_id,
            scope.drive_id,
            scope.folder_id,
            scope.include_subfolders
          FROM ${this.bindings} AS binding
          JOIN ${this.scopes} AS scope
            ON scope.tenant_id = binding.tenant_id
           AND scope.binding_id = binding.id
          WHERE binding.tenant_id = $1
            AND binding.workflow_version_id = $2
            AND binding.connector_id = 'microsoft-sharepoint'
            AND binding.capability = 'ENTRY'
            AND binding.capability_version = 1
          FOR UPDATE
        `,
        [input.tenantId, input.workflowVersionId],
      )) as {
        capability_hash: string;
        configuration_hash: string;
        connection_id: string;
        drive_id: string;
        folder_id: string;
        id: string;
        include_subfolders: boolean;
        site_id: string;
      }[];
      const existingBinding = existingBindings[0];
      if (existingBinding !== undefined) {
        if (
          existingBinding.capability_hash !== input.capabilityHash ||
          existingBinding.configuration_hash !== input.configurationHash ||
          existingBinding.connection_id !== input.connectionId ||
          existingBinding.site_id !== input.configuration.siteId ||
          existingBinding.drive_id !== input.configuration.driveId ||
          existingBinding.folder_id !== input.configuration.folderId ||
          existingBinding.include_subfolders !==
            input.configuration.includeSubfolders
        ) {
          throw new Error('SHAREPOINT_BINDING_IDENTITY_CONFLICT');
        }
        const existing = await this.findState(
          manager,
          input.tenantId,
          existingBinding.id,
        );
        this.assertExistingScope(existing, input);
        return existing;
      }

      let watches = (await manager.query(
        `
          SELECT
            id,
            external_tenant_id,
            site_id,
            drive_id,
            root_item_id,
            resource,
            client_state_digest
          FROM ${this.watches}
          WHERE tenant_id = $1 AND connection_id = $2 AND drive_id = $3
          FOR UPDATE
        `,
        [input.tenantId, input.connectionId, input.target.driveId],
      )) as WatchIdentityRow[];
      if (watches[0] === undefined) {
        await manager.query(
          `
            INSERT INTO ${this.watches} (
              id,
              tenant_id,
              connection_id,
              external_tenant_id,
              site_id,
              drive_id,
              root_item_id,
              resource,
              change_type,
              client_state_key_version,
              client_state_digest
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8,
              'updated', $9, $10
            )
            ON CONFLICT (tenant_id, connection_id, drive_id) DO NOTHING
          `,
          [
            input.watchId,
            input.tenantId,
            input.connectionId,
            input.target.externalTenantId,
            input.target.siteId,
            input.target.driveId,
            input.target.rootItemId,
            input.resource,
            input.clientStateKeyVersion,
            input.clientStateDigest,
          ],
        );
        watches = (await manager.query(
          `
            SELECT
              id,
              external_tenant_id,
              site_id,
              drive_id,
              root_item_id,
              resource,
              client_state_digest
            FROM ${this.watches}
            WHERE tenant_id = $1 AND connection_id = $2 AND drive_id = $3
            FOR UPDATE
          `,
          [input.tenantId, input.connectionId, input.target.driveId],
        )) as WatchIdentityRow[];
      }
      const watch = watches[0];
      if (
        watch === undefined ||
        watch.external_tenant_id !== input.target.externalTenantId ||
        watch.site_id !== input.target.siteId ||
        watch.drive_id !== input.target.driveId ||
        watch.root_item_id !== input.target.rootItemId ||
        watch.resource !== input.resource
      ) {
        throw new Error('SHAREPOINT_WATCH_IDENTITY_CONFLICT');
      }

      await manager.query(
        `
          INSERT INTO ${this.bindings} (
            id,
            tenant_id,
            project_id,
            workflow_id,
            workflow_version_id,
            connector_id,
            capability,
            capability_version,
            configuration_schema_version,
            connection_id,
            configuration_hash,
            capability_hash,
            provisioning_key,
            provider_resource_ref
          ) VALUES (
            $1, $2, $3, $4, $5,
            'microsoft-sharepoint', 'ENTRY', 1, 1, $6,
            $7, $8, $9, $10
          )
        `,
        [
          input.bindingId,
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.workflowVersionId,
          input.connectionId,
          input.configurationHash,
          input.capabilityHash,
          input.operationId,
          watch.id,
        ],
      );
      await manager.query(
        `
          INSERT INTO ${this.scopes} (
            tenant_id,
            binding_id,
            watch_id,
            site_id,
            drive_id,
            folder_id,
            include_subfolders,
            binding_generation
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
        `,
        [
          input.tenantId,
          input.bindingId,
          watch.id,
          input.configuration.siteId,
          input.configuration.driveId,
          input.configuration.folderId,
          input.configuration.includeSubfolders,
        ],
      );
      return this.findState(manager, input.tenantId, input.bindingId);
    });
  }

  async saveSubscription(
    input: Parameters<SharePointProvisioningRepository['saveSubscription']>[0],
  ): Promise<SharePointProvisioningState> {
    return this.dataSource.transaction(async (manager) => {
      const rows = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.watches}
            SET subscription_id = $5,
                subscription_expires_at = $6,
                subscription_status = 'ACTIVE',
                state_version = state_version + 1,
                next_reconcile_at = LEAST(
                  next_reconcile_at,
                  $6::timestamptz - interval '7 days'
                ),
                failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND state_version = $3
              AND resource = $4
              AND change_type = $7
              AND client_state_digest = $8
            RETURNING id
          `,
          [
            input.tenantId,
            input.watchId,
            input.expectedStateVersion,
            input.subscription.resource,
            input.subscription.id,
            input.subscription.expiresAt,
            input.subscription.changeType,
            sharePointClientStateDigest(input.subscription.clientState),
          ],
        ),
      );
      if (rows.length !== 1) {
        throw new Error('SHAREPOINT_WATCH_STATE_CONFLICT');
      }
      return this.findState(manager, input.tenantId, input.bindingId);
    });
  }

  async saveBaselinePage(
    input: Parameters<SharePointProvisioningRepository['saveBaselinePage']>[0],
  ): Promise<SharePointProvisioningState> {
    if (
      input.items.length > 1_000 ||
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

    return this.dataSource.transaction(async (manager) => {
      const watches = (await manager.query(
        `
          SELECT id, inventory_generation
          FROM ${this.watches}
          WHERE tenant_id = $1
            AND id = $2
            AND state_version = $3
            AND baseline_status IN ('PENDING', 'RUNNING')
          FOR UPDATE
        `,
        [input.tenantId, input.watchId, input.expectedStateVersion],
      )) as { id: string; inventory_generation: number | string }[];
      if (watches.length !== 1) {
        throw new Error('SHAREPOINT_WATCH_STATE_CONFLICT');
      }

      for (const item of input.items) {
        await this.upsertItem(
          manager,
          input.tenantId,
          input.watchId,
          Number(watches[0]!.inventory_generation),
          input.observedAt,
          item,
        );
      }
      const updated = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.watches}
            SET baseline_status = $4::varchar,
                committed_delta_cursor_ciphertext = CASE
                  WHEN $4::varchar = 'COMPLETE' THEN $5
                  ELSE committed_delta_cursor_ciphertext
                END,
                scan_next_cursor_ciphertext = $6,
                state_version = state_version + 1,
                next_reconcile_at = clock_timestamp(),
                failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND state_version = $3
            RETURNING id
          `,
          [
            input.tenantId,
            input.watchId,
            input.expectedStateVersion,
            input.finalCursor === undefined ? 'RUNNING' : 'COMPLETE',
            finalCiphertext === undefined ? null : Buffer.from(finalCiphertext),
            nextCiphertext === undefined ? null : Buffer.from(nextCiphertext),
          ],
        ),
      );
      if (updated.length !== 1) {
        throw new Error('SHAREPOINT_WATCH_STATE_CONFLICT');
      }
      return this.findState(manager, input.tenantId, input.bindingId);
    });
  }

  private async findState(
    manager: EntityManager,
    tenantId: string,
    bindingId: string,
  ): Promise<SharePointProvisioningState> {
    const rows = (await manager.query(
      `
        SELECT
          binding.id AS binding_id,
          watch.id AS watch_id,
          watch.tenant_id,
          watch.connection_id,
          watch.external_tenant_id,
          watch.site_id,
          watch.drive_id,
          watch.resource,
          watch.client_state_key_version,
          watch.client_state_digest,
          watch.committed_delta_cursor_ciphertext,
          watch.scan_next_cursor_ciphertext,
          watch.baseline_status,
          watch.subscription_status,
          watch.subscription_id,
          watch.subscription_expires_at,
          watch.state_version
        FROM ${this.bindings} AS binding
        JOIN ${this.scopes} AS scope
          ON scope.tenant_id = binding.tenant_id
         AND scope.binding_id = binding.id
        JOIN ${this.watches} AS watch
          ON watch.tenant_id = scope.tenant_id
         AND watch.id = scope.watch_id
        WHERE binding.tenant_id = $1 AND binding.id = $2
      `,
      [tenantId, bindingId],
    )) as ProvisioningStateRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error('SHAREPOINT_PROVISIONING_STATE_NOT_FOUND');
    }
    return {
      baselineStatus: baselineStatus(row.baseline_status),
      bindingId: row.binding_id,
      clientStateDigest: row.client_state_digest,
      clientStateKeyVersion: Number(row.client_state_key_version),
      ...(row.committed_delta_cursor_ciphertext === null
        ? {}
        : {
            committedDeltaCursor: this.cursorProtector.unprotect(
              row.committed_delta_cursor_ciphertext,
            ),
          }),
      connectionId: row.connection_id,
      driveId: row.drive_id,
      externalTenantId: row.external_tenant_id,
      resource: row.resource,
      ...(row.scan_next_cursor_ciphertext === null
        ? {}
        : {
            scanNextCursor: this.cursorProtector.unprotect(
              row.scan_next_cursor_ciphertext,
            ),
          }),
      siteId: row.site_id,
      stateVersion: Number(row.state_version),
      ...(row.subscription_expires_at === null
        ? {}
        : {
            subscriptionExpiresAt: new Date(row.subscription_expires_at),
          }),
      ...(row.subscription_id === null
        ? {}
        : { subscriptionId: row.subscription_id }),
      subscriptionStatus: subscriptionStatus(row.subscription_status),
      tenantId: row.tenant_id,
      watchId: row.watch_id,
    };
  }

  private assertExistingScope(
    state: SharePointProvisioningState,
    input: Parameters<
      SharePointProvisioningRepository['ensureBindingAndWatch']
    >[0],
  ): void {
    if (
      state.tenantId !== input.tenantId ||
      state.connectionId !== input.connectionId ||
      state.externalTenantId !== input.target.externalTenantId ||
      state.siteId !== input.configuration.siteId ||
      state.driveId !== input.configuration.driveId ||
      state.resource !== input.resource
    ) {
      throw new Error('SHAREPOINT_BINDING_IDENTITY_CONFLICT');
    }
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
    tenantId: string,
    watchId: string,
    generation: number,
    observedAt: Date,
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
        tenantId,
        watchId,
        item.id,
        item.parentId ?? null,
        item.kind,
        item.kind === 'DELETED' ? null : item.name,
        item.kind === 'FILE' ? (item.contentType ?? null) : null,
        item.kind === 'FILE' ? item.sizeBytes : null,
        item.kind === 'FILE' ? (item.cTag ?? null) : null,
        item.kind === 'DELETED' ? null : item.eTag,
        generation,
        observedAt,
      ],
    );
  }
}
