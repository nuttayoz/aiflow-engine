import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { createMessageEnvelope } from '@aiflow/messaging';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

const assertBatchSize = (batchSize: number): void => {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('RECOVERY_BATCH_SIZE_INVALID');
  }
};

export class PostgresSharePointRecoveryRepository {
  private readonly bindings: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly scopes: string;
  private readonly watches: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.bindings = table(schema, 'connector_provisioning_bindings');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.scopes = table(schema, 'sharepoint_binding_scopes');
    this.watches = table(schema, 'sharepoint_drive_watches');
  }

  async enqueueDueReconciliations(batchSize: number): Promise<number> {
    assertBatchSize(batchSize);
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT watch.id, watch.tenant_id, binding.project_id
          FROM ${this.watches} AS watch
          JOIN LATERAL (
            SELECT binding.project_id
            FROM ${this.scopes} AS scope
            JOIN ${this.bindings} AS binding
              ON binding.tenant_id = scope.tenant_id
             AND binding.id = scope.binding_id
            WHERE scope.tenant_id = watch.tenant_id
              AND scope.watch_id = watch.id
              AND binding.status IN ('ACTIVE', 'DRAINING')
              AND binding.accepting_new_documents
            ORDER BY binding.created_at, binding.id
            LIMIT 1
          ) AS binding ON true
          WHERE watch.baseline_status = 'COMPLETE'
            AND watch.subscription_status = 'ACTIVE'
            AND NOT watch.sync_command_pending
            AND watch.next_reconcile_at <= clock_timestamp()
            AND (
              watch.lease_expires_at IS NULL
              OR watch.lease_expires_at <= clock_timestamp()
            )
          ORDER BY watch.next_reconcile_at, watch.id
          LIMIT $1
          FOR UPDATE OF watch SKIP LOCKED
        `,
        [batchSize],
      )) as { id: string; project_id: string; tenant_id: string }[];
      for (const row of rows) {
        const updated = mutationRows<{
          notification_generation: number | string;
          state_version: number | string;
        }>(
          await manager.query(
            `
              UPDATE ${this.watches}
              SET sync_command_pending = true,
                  state_version = state_version + 1,
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND id = $2
              RETURNING state_version, notification_generation
            `,
            [row.tenant_id, row.id],
          ),
        )[0];
        if (updated === undefined) continue;
        const envelope = createMessageEnvelope({
          actor: { id: 'microsoft-sharepoint-scheduler', type: 'SYSTEM' },
          causationId: row.id,
          correlationId: row.id,
          data: {
            expectedNotificationGeneration: Number(
              updated.notification_generation,
            ),
            expectedStateVersion: Number(updated.state_version),
            watchId: row.id,
          },
          projectId: row.project_id,
          tenantId: row.tenant_id,
          type: 'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
        });
        await this.outbox.append(queryRunner(manager), {
          aggregateId: row.id,
          aggregateType: 'SHAREPOINT_DRIVE_WATCH',
          envelope,
        });
      }
      return rows.length;
    });
  }
}

export class PostgresSharePointIngestionRecoveryRepository {
  private readonly ingestions: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly storageObjects: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.ingestions = table(schema, 'document_ingestions');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.storageObjects = table(schema, 'storage_objects');
  }

  async recoverExpiredLeases(batchSize: number): Promise<number> {
    assertBatchSize(batchSize);
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT id, tenant_id, project_id, storage_object_id
          FROM ${this.ingestions}
          WHERE status = 'RUNNING'
            AND lease_expires_at <= clock_timestamp()
          ORDER BY lease_expires_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [batchSize],
      )) as {
        id: string;
        project_id: string;
        storage_object_id: null | string;
        tenant_id: string;
      }[];

      for (const row of rows) {
        if (row.storage_object_id !== null) {
          await manager.query(
            `
              UPDATE ${this.storageObjects}
              SET status = 'ABANDONED',
                  state_version = state_version + 1,
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1
                AND id = $2
                AND status = 'RESERVED'
            `,
            [row.tenant_id, row.storage_object_id],
          );
        }

        const recovered = mutationRows<{
          next_attempt_at: Date | string;
          state_version: number | string;
        }>(
          await manager.query(
            `
              UPDATE ${this.ingestions}
              SET status = 'WAITING_RETRY',
                  state_version = state_version + 1,
                  next_attempt_at = clock_timestamp() + interval '1 second',
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  storage_object_id = NULL,
                  failure_code = 'SHAREPOINT_INGESTION_LEASE_EXPIRED',
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1
                AND id = $2
                AND status = 'RUNNING'
              RETURNING state_version, next_attempt_at
            `,
            [row.tenant_id, row.id],
          ),
        )[0];
        if (recovered === undefined) continue;

        const retryAt = new Date(recovered.next_attempt_at);
        const envelope = createMessageEnvelope({
          actor: { id: 'microsoft-sharepoint-scheduler', type: 'SYSTEM' },
          causationId: row.id,
          correlationId: row.id,
          data: {
            connectorId: 'microsoft-sharepoint',
            expectedStateVersion: Number(recovered.state_version),
            ingestionId: row.id,
          },
          occurredAt: retryAt,
          projectId: row.project_id,
          tenantId: row.tenant_id,
          type: 'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
        });
        await this.outbox.append(queryRunner(manager), {
          aggregateId: row.id,
          aggregateType: 'DOCUMENT_INGESTION',
          availableAt: retryAt,
          envelope,
        });
      }

      return rows.length;
    });
  }
}
