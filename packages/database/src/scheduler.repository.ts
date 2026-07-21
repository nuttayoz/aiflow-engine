import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import type {
  ExecutionRecoveryRepository,
  ExecutionStage,
  RecoveryBatchResult,
  SchedulerLeaseRecord,
  SchedulerLeaseRepository,
} from '@aiflow/executions';
import { createMessageEnvelope, type MessageType } from '@aiflow/messaging';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface RecoveryRow {
  actor_id: string;
  actor_type: 'SERVICE' | 'SYSTEM' | 'USER';
  attempt_count: number | string;
  causation_id: string;
  correlation_id: string;
  execution_id: string;
  execution_state_version: number | string;
  project_id: string;
  stage: ExecutionStage;
  stage_id: string;
  tenant_id: string;
  workflow_version_id: string;
}

const assertBatchSize = (batchSize: number): void => {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('RECOVERY_BATCH_SIZE_INVALID');
  }
};

const commandType = (
  stage: ExecutionStage,
  connectorId?: string,
): MessageType => {
  switch (stage) {
    case 'EXTRACT':
      return 'aiflow.execution.stage.extract.requested.v1';
    case 'MAP':
      return 'aiflow.execution.stage.map.requested.v1';
    case 'REVIEW':
      return 'aiflow.execution.stage.review.requested.v1';
    case 'DELIVER':
      if (connectorId === undefined) {
        throw new Error('DELIVERY_CONNECTOR_REQUIRED');
      }
      return `aiflow.execution.stage.deliver.connector.${connectorId}.requested.v1`;
  }
};

export class PostgresSchedulerLeaseRepository implements SchedulerLeaseRepository {
  private readonly leases: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.leases = table(schema, 'scheduler_leases');
  }

  async acquire(input: {
    readonly durationMs: number;
    readonly jobName: string;
    readonly owner: string;
  }): Promise<SchedulerLeaseRecord | undefined> {
    if (
      !Number.isInteger(input.durationMs) ||
      input.durationMs < 1_000 ||
      input.durationMs > 300_000 ||
      input.jobName.length === 0 ||
      input.jobName.length > 180 ||
      input.owner.length === 0 ||
      input.owner.length > 180
    ) {
      throw new Error('SCHEDULER_LEASE_INPUT_INVALID');
    }

    const rows = mutationRows<{
      fencing_version: number | string;
      job_name: string;
      lease_expires_at: Date | string;
      lease_owner: string;
    }>(
      await this.dataSource.query(
        `
        INSERT INTO ${this.leases} (
          job_name, lease_owner, lease_expires_at, fencing_version
        ) VALUES ($1, $2, clock_timestamp() + ($3 * interval '1 millisecond'), 1)
        ON CONFLICT (job_name) DO UPDATE
        SET lease_owner = EXCLUDED.lease_owner,
            lease_expires_at = EXCLUDED.lease_expires_at,
            fencing_version = CASE
              WHEN ${this.leases}.lease_owner = EXCLUDED.lease_owner
                THEN ${this.leases}.fencing_version
              ELSE ${this.leases}.fencing_version + 1
            END,
            updated_at = clock_timestamp()
        WHERE ${this.leases}.lease_owner = EXCLUDED.lease_owner
           OR ${this.leases}.lease_expires_at <= clock_timestamp()
        RETURNING job_name, lease_owner, lease_expires_at, fencing_version
      `,
        [input.jobName, input.owner, input.durationMs],
      ),
    );
    const row = rows[0];

    return row === undefined
      ? undefined
      : {
          fencingVersion: Number(row.fencing_version),
          jobName: row.job_name,
          leaseExpiresAt: new Date(row.lease_expires_at),
          leaseOwner: row.lease_owner,
        };
  }
}

export class PostgresExecutionRecoveryRepository implements ExecutionRecoveryRepository {
  private readonly auditEvents: string;
  private readonly attempts: string;
  private readonly executions: string;
  private readonly deliveryOperations: string;
  private readonly stages: string;
  private readonly versions: string;
  private readonly outbox: PostgresOutboxRepository;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.auditEvents = table(schema, 'audit_events');
    this.attempts = table(schema, 'stage_attempts');
    this.executions = table(schema, 'executions');
    this.deliveryOperations = table(schema, 'delivery_operations');
    this.stages = table(schema, 'execution_stages');
    this.versions = table(schema, 'workflow_versions');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
  }

  async recoverExpiredLeases(
    batchSize: number,
    retryDelayMs: number,
  ): Promise<RecoveryBatchResult> {
    assertBatchSize(batchSize);
    if (
      !Number.isInteger(retryDelayMs) ||
      retryDelayMs < 1_000 ||
      retryDelayMs > 300_000
    ) {
      throw new Error('RECOVERY_RETRY_DELAY_INVALID');
    }

    const processed = await this.dataSource.transaction(async (manager) => {
      const rows = await this.lockRecoveryRows(
        manager,
        `stage.status = 'RUNNING' AND stage.lease_expires_at <= clock_timestamp()`,
        batchSize,
      );

      for (const row of rows) {
        await manager.query(
          `
            UPDATE ${this.attempts}
            SET status = 'TIMED_OUT',
                finished_at = clock_timestamp(),
                failure_code = $5,
                failure_category = $6
            WHERE tenant_id = $1
              AND execution_id = $2
              AND execution_stage_id = $3
              AND attempt_number = $4
              AND status = 'RUNNING'
          `,
          [
            row.tenant_id,
            row.execution_id,
            row.stage_id,
            Number(row.attempt_count),
            row.stage === 'DELIVER'
              ? 'DESTINATION_OUTCOME_UNKNOWN'
              : 'WORKER_LEASE_EXPIRED',
            row.stage === 'DELIVER' ? 'UNKNOWN_OUTCOME' : 'TRANSIENT',
          ],
        );

        if (row.stage === 'DELIVER') {
          await manager.query(
            `
              UPDATE ${this.deliveryOperations}
              SET status = 'UNKNOWN',
                  state_version = state_version + 1,
                  next_check_at = clock_timestamp(),
                  failure_code = 'DESTINATION_OUTCOME_UNKNOWN',
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1
                AND current_execution_id = $2
                AND status = 'SUBMITTING'
            `,
            [row.tenant_id, row.execution_id],
          );
          await manager.query(
            `
              UPDATE ${this.stages}
              SET status = 'WAITING',
                  state_version = state_version + 1,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  failure_code = 'DESTINATION_OUTCOME_UNKNOWN',
                  failure_category = 'UNKNOWN_OUTCOME',
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND id = $2
            `,
            [row.tenant_id, row.stage_id],
          );
          await this.incrementExecutionForRecovery(
            manager,
            row,
            'DESTINATION_OUTCOME_UNKNOWN',
            'UNKNOWN_OUTCOME',
            'The destination result could not be confirmed.',
          );
          await this.appendReconcileMessage(manager, row);
        } else {
          await manager.query(
            `
              UPDATE ${this.stages}
              SET status = 'RETRY_SCHEDULED',
                  state_version = state_version + 1,
                  next_attempt_at = clock_timestamp() + ($3 * interval '1 millisecond'),
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  failure_code = 'WORKER_LEASE_EXPIRED',
                  failure_category = 'TRANSIENT',
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND id = $2
            `,
            [row.tenant_id, row.stage_id, retryDelayMs],
          );
          await this.incrementExecutionForRecovery(
            manager,
            row,
            'WORKER_LEASE_EXPIRED',
            'TRANSIENT',
            'The worker lease expired and the stage will be retried.',
          );
        }
        await this.appendRecoveryAudit(manager, row);
      }

      return rows.length;
    });

    return { processed };
  }

  async enqueueDueRetries(batchSize: number): Promise<RecoveryBatchResult> {
    assertBatchSize(batchSize);
    const processed = await this.dataSource.transaction(async (manager) => {
      const rows = await this.lockRecoveryRows(
        manager,
        `stage.status = 'RETRY_SCHEDULED' AND stage.next_attempt_at <= clock_timestamp()`,
        batchSize,
      );

      for (const row of rows) {
        const nextStateVersion = Number(row.execution_state_version) + 1;
        await manager.query(
          `
            UPDATE ${this.stages}
            SET status = 'PENDING',
                state_version = state_version + 1,
                next_attempt_at = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2
          `,
          [row.tenant_id, row.stage_id],
        );
        await manager.query(
          `
            UPDATE ${this.executions}
            SET state_version = state_version + 1,
                transitioned_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND state_version = $3
          `,
          [
            row.tenant_id,
            row.execution_id,
            Number(row.execution_state_version),
          ],
        );
        const connectorId =
          row.stage === 'DELIVER'
            ? await this.destinationConnectorId(manager, row)
            : undefined;
        const message = createMessageEnvelope({
          actor: { id: row.actor_id, type: row.actor_type },
          causationId: row.causation_id,
          correlationId: row.correlation_id,
          data: {
            ...(connectorId === undefined ? {} : { connectorId }),
            executionId: row.execution_id,
            expectedStateVersion: nextStateVersion,
            stage: row.stage,
          },
          projectId: row.project_id,
          tenantId: row.tenant_id,
          type: commandType(row.stage, connectorId),
        });
        if (manager.queryRunner === undefined) {
          throw new Error('DATABASE_TRANSACTION_REQUIRED');
        }
        await this.outbox.append(manager.queryRunner, {
          aggregateId: row.execution_id,
          aggregateType: 'EXECUTION',
          envelope: message,
        });
      }

      return rows.length;
    });

    return { processed };
  }

  private async lockRecoveryRows(
    manager: EntityManager,
    condition: string,
    batchSize: number,
  ): Promise<RecoveryRow[]> {
    return (await manager.query(
      `
        SELECT
          stage.id AS stage_id,
          stage.stage,
          stage.attempt_count,
          execution.id AS execution_id,
          execution.tenant_id,
          execution.project_id,
          execution.workflow_version_id,
          execution.state_version AS execution_state_version,
          execution.actor_type,
          execution.actor_id,
          execution.correlation_id,
          execution.causation_id
        FROM ${this.stages} AS stage
        JOIN ${this.executions} AS execution
          ON execution.tenant_id = stage.tenant_id
         AND execution.id = stage.execution_id
        WHERE ${condition}
          AND execution.status NOT IN ('SUCCEEDED', 'FAILED', 'REJECTED')
        ORDER BY stage.lease_expires_at NULLS LAST, stage.next_attempt_at NULLS LAST, stage.execution_id
        LIMIT $1
        FOR UPDATE OF execution, stage SKIP LOCKED
      `,
      [batchSize],
    )) as RecoveryRow[];
  }

  private async incrementExecutionForRecovery(
    manager: EntityManager,
    row: RecoveryRow,
    code: string,
    category: 'TRANSIENT' | 'UNKNOWN_OUTCOME',
    message: string,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE ${this.executions}
        SET state_version = state_version + 1,
            failure_code = $4,
            failure_category = $5,
            failure_message = $6,
            transitioned_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND state_version = $3
      `,
      [
        row.tenant_id,
        row.execution_id,
        Number(row.execution_state_version),
        code,
        category,
        message,
      ],
    );
  }

  private async appendReconcileMessage(
    manager: EntityManager,
    row: RecoveryRow,
  ): Promise<void> {
    const message = createMessageEnvelope({
      actor: { id: row.actor_id, type: row.actor_type },
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      data: {
        executionId: row.execution_id,
        expectedStateVersion: Number(row.execution_state_version) + 1,
        stage: row.stage,
      },
      projectId: row.project_id,
      tenantId: row.tenant_id,
      type: 'aiflow.execution.stage.reconcile.requested.v1',
    });
    if (manager.queryRunner === undefined) {
      throw new Error('DATABASE_TRANSACTION_REQUIRED');
    }
    await this.outbox.append(manager.queryRunner, {
      aggregateId: row.execution_id,
      aggregateType: 'EXECUTION',
      envelope: message,
    });
  }

  private async destinationConnectorId(
    manager: EntityManager,
    row: RecoveryRow,
  ): Promise<string> {
    const versions = (await manager.query(
      `
        SELECT definition #>> '{destination,connectorId}' AS connector_id
        FROM ${this.versions}
        WHERE tenant_id = $1 AND id = $2
      `,
      [row.tenant_id, row.workflow_version_id],
    )) as { connector_id: string | null }[];
    const connectorId = versions[0]?.connector_id;
    if (connectorId === null || connectorId === undefined) {
      throw new Error('DESTINATION_CONNECTOR_MISSING');
    }
    return connectorId;
  }

  private async appendRecoveryAudit(
    manager: EntityManager,
    row: RecoveryRow,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO ${this.auditEvents} (
          id,
          tenant_id,
          project_id,
          actor_type,
          actor_id,
          action,
          resource_type,
          resource_id,
          outcome,
          correlation_id,
          causation_id,
          workflow_version_id,
          metadata
        ) VALUES ($1, $2, $3, 'SYSTEM', 'scheduler', 'execution.lease.recover', 'EXECUTION', $4, 'SUCCEEDED', $5, $6, $7, $8::jsonb)
      `,
      [
        randomUUID(),
        row.tenant_id,
        row.project_id,
        row.execution_id,
        row.correlation_id,
        row.causation_id,
        row.workflow_version_id,
        JSON.stringify({ stage: row.stage }),
      ],
    );
  }
}
