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
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new Error('RECOVERY_BATCH_SIZE_INVALID');
    }
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
