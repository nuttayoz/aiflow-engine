import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import { createMessageEnvelope } from '@aiflow/messaging';
import type {
  ClaimProvisioningOperationInput,
  ProvisioningOperationRecord,
  RequestWorkflowActivationInput,
  WorkflowProvisioningRepository,
} from '@aiflow/workflows';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface OperationRow {
  actor_id: string;
  actor_type: ProvisioningOperationRecord['actor']['type'];
  attempt_count: number | string;
  causation_id: string;
  completed_at: Date | string | null;
  correlation_id: string;
  created_at: Date | string;
  current_step: ProvisioningOperationRecord['currentStep'];
  definition_hash: string | null;
  id: string;
  kind: ProvisioningOperationRecord['kind'];
  previous_version_id: string | null;
  project_id: string;
  state_version: number | string;
  status: ProvisioningOperationRecord['status'];
  target_version_id: string | null;
  tenant_id: string;
  updated_at: Date | string;
  workflow_id: string;
}

const operationColumns = `
  id,
  tenant_id,
  project_id,
  workflow_id,
  target_version_id,
  previous_version_id,
  kind,
  status,
  current_step,
  definition_hash,
  state_version,
  attempt_count,
  actor_type,
  actor_id,
  correlation_id,
  causation_id,
  created_at,
  updated_at,
  completed_at
`;

const mapOperation = (row: OperationRow): ProvisioningOperationRecord => ({
  actor: { id: row.actor_id, type: row.actor_type },
  attemptCount: Number(row.attempt_count),
  causationId: row.causation_id,
  ...(row.completed_at === null
    ? {}
    : { completedAt: new Date(row.completed_at) }),
  correlationId: row.correlation_id,
  createdAt: new Date(row.created_at),
  currentStep: row.current_step,
  ...(row.definition_hash === null
    ? {}
    : { definitionHash: row.definition_hash }),
  id: row.id,
  kind: row.kind,
  ...(row.previous_version_id === null
    ? {}
    : { previousVersionId: row.previous_version_id }),
  projectId: row.project_id,
  stateVersion: Number(row.state_version),
  status: row.status,
  ...(row.target_version_id === null
    ? {}
    : { targetVersionId: row.target_version_id }),
  tenantId: row.tenant_id,
  updatedAt: new Date(row.updated_at),
  workflowId: row.workflow_id,
});

const requestFingerprint = (input: RequestWorkflowActivationInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        projectId: input.projectId,
        targetVersionId: input.targetVersionId,
        workflowId: input.workflowId,
      }),
    )
    .digest('hex');

export class PostgresWorkflowProvisioningRepository implements WorkflowProvisioningRepository {
  private readonly auditEvents: string;
  private readonly idempotency: string;
  private readonly inboxMessages: string;
  private readonly operations: string;
  private readonly versions: string;
  private readonly workflows: string;
  private readonly outbox: PostgresOutboxRepository;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.auditEvents = table(schema, 'audit_events');
    this.idempotency = table(schema, 'idempotency_records');
    this.inboxMessages = table(schema, 'inbox_messages');
    this.operations = table(schema, 'workflow_activation_operations');
    this.versions = table(schema, 'workflow_versions');
    this.workflows = table(schema, 'workflows');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
  }

  async requestActivation(
    input: RequestWorkflowActivationInput,
  ): Promise<ProvisioningOperationRecord> {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    }
    const fingerprint = requestFingerprint(input);

    const operationId = await this.dataSource.transaction(async (manager) => {
      const inserted = (await manager.query(
        `
          INSERT INTO ${this.idempotency} (
            id,
            tenant_id,
            operation_scope,
            idempotency_key,
            request_fingerprint,
            status,
            resource_type,
            resource_id,
            completed_at,
            expires_at
          ) VALUES ($1, $2, 'workflow.activate', $3, $4, 'COMPLETED', 'PROVISIONING_OPERATION', $5, clock_timestamp(), clock_timestamp() + interval '90 days')
          ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
          RETURNING resource_id
        `,
        [
          randomUUID(),
          input.tenantId,
          input.idempotencyKey,
          fingerprint,
          input.operationId,
        ],
      )) as { resource_id: string }[];

      if (inserted.length === 0) {
        const existing = (await manager.query(
          `
            SELECT request_fingerprint, resource_id
            FROM ${this.idempotency}
            WHERE tenant_id = $1
              AND operation_scope = 'workflow.activate'
              AND idempotency_key = $2
            FOR UPDATE
          `,
          [input.tenantId, input.idempotencyKey],
        )) as { request_fingerprint: string; resource_id: string | null }[];
        if (existing[0]?.request_fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        if (existing[0]?.resource_id === null || existing[0] === undefined) {
          throw new Error('IDEMPOTENCY_IN_PROGRESS');
        }
        return existing[0].resource_id;
      }

      const targets = (await manager.query(
        `
          SELECT
            workflow.active_version_id,
            version.definition_hash
          FROM ${this.workflows} AS workflow
          JOIN ${this.versions} AS version
            ON version.tenant_id = workflow.tenant_id
           AND version.workflow_id = workflow.id
          WHERE workflow.tenant_id = $1
            AND workflow.project_id = $2
            AND workflow.id = $3
            AND version.id = $4
          FOR UPDATE OF workflow
        `,
        [
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.targetVersionId,
        ],
      )) as {
        active_version_id: string | null;
        definition_hash: string;
      }[];
      const target = targets[0];
      if (target === undefined) {
        throw new Error('WORKFLOW_VERSION_NOT_FOUND');
      }

      await manager.query(
        `
          INSERT INTO ${this.operations} (
            id,
            tenant_id,
            project_id,
            workflow_id,
            target_version_id,
            previous_version_id,
            kind,
            status,
            current_step,
            definition_hash,
            actor_type,
            actor_id,
            correlation_id,
            causation_id
          ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVATE', 'PENDING', 'VALIDATE', $7, $8, $9, $10, $11)
        `,
        [
          input.operationId,
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.targetVersionId,
          target.active_version_id,
          target.definition_hash,
          input.actor.type,
          input.actor.id,
          input.correlationId,
          input.causationId,
        ],
      );
      const message = createMessageEnvelope({
        actor: input.actor,
        causationId: input.causationId,
        correlationId: input.correlationId,
        data: {
          expectedStateVersion: 0,
          provisioningOperationId: input.operationId,
        },
        projectId: input.projectId,
        tenantId: input.tenantId,
        type: 'aiflow.workflow.provisioning.requested.v1',
      });
      if (manager.queryRunner === undefined) {
        throw new Error('DATABASE_TRANSACTION_REQUIRED');
      }
      await this.outbox.append(manager.queryRunner, {
        aggregateId: input.operationId,
        aggregateType: 'PROVISIONING_OPERATION',
        envelope: message,
      });
      await this.appendAudit(manager, input, 'workflow.activation.request');

      return input.operationId;
    });

    const operation = await this.findById(input.tenantId, operationId);
    if (operation === undefined) {
      throw new Error('PROVISIONING_OPERATION_INCONSISTENT');
    }
    return operation;
  }

  async claim(
    input: ClaimProvisioningOperationInput,
  ): Promise<ProvisioningOperationRecord | undefined> {
    if (
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 300_000
    ) {
      throw new Error('LEASE_DURATION_INVALID');
    }
    const row = await this.dataSource.transaction(async (manager) => {
      const inbox = (await manager.query(
        `
          INSERT INTO ${this.inboxMessages} (
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
          ) VALUES ($1, $2, $3, $4, $5, $6, 'PROVISIONING_OPERATION', $7, 'CLAIMED', clock_timestamp() + interval '90 days')
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
          input.operationId,
        ],
      )) as { id: string }[];
      if (inbox.length === 0) {
        return undefined;
      }

      const rows = mutationRows<OperationRow>(
        await manager.query(
          `
          UPDATE ${this.operations}
          SET status = 'RUNNING',
              state_version = state_version + 1,
              attempt_count = attempt_count + 1,
              lease_owner = $5,
              lease_expires_at = clock_timestamp() + ($6 * interval '1 millisecond'),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND project_id = $2
            AND id = $3
            AND state_version = $4
            AND (
              status = 'PENDING'
              OR (status = 'WAITING_RETRY' AND next_attempt_at <= clock_timestamp())
              OR status = 'RECONCILING'
            )
          RETURNING ${operationColumns}
        `,
          [
            input.tenantId,
            input.projectId,
            input.operationId,
            input.expectedStateVersion,
            input.leaseOwner,
            input.leaseDurationMs,
          ],
        ),
      );
      if (rows[0] === undefined) {
        await manager.query(
          `
            UPDATE ${this.inboxMessages}
            SET outcome = 'STALE', completed_at = clock_timestamp()
            WHERE consumer_name = $1 AND message_id = $2
          `,
          [input.consumerName, input.messageId],
        );
        return undefined;
      }

      return rows[0];
    });

    return row === undefined ? undefined : mapOperation(row);
  }

  async completeActivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord> {
    await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT ${operationColumns}
          FROM ${this.operations}
          WHERE tenant_id = $1
            AND id = $2
            AND state_version = $3
            AND status = 'RUNNING'
            AND lease_owner = $4
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE
        `,
        [
          input.tenantId,
          input.operationId,
          input.expectedStateVersion,
          input.leaseOwner,
        ],
      )) as OperationRow[];
      const operation = rows[0];
      if (operation?.target_version_id === null || operation === undefined) {
        throw new Error('PROVISIONING_LEASE_LOST');
      }

      const workflows = mutationRows<{ id: string }>(
        await manager.query(
          `
          UPDATE ${this.workflows}
          SET active_version_id = $4,
              accepting_new_documents = true,
              status = 'ACTIVE',
              health = 'HEALTHY',
              state_version = state_version + 1,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND project_id = $2
            AND id = $3
          RETURNING id
        `,
          [
            operation.tenant_id,
            operation.project_id,
            operation.workflow_id,
            operation.target_version_id,
          ],
        ),
      );
      if (workflows.length !== 1) {
        throw new Error('WORKFLOW_ACTIVATION_CONFLICT');
      }

      await manager.query(
        `
          UPDATE ${this.operations}
          SET status = 'SUCCEEDED',
              current_step = 'SWITCH',
              state_version = state_version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [input.tenantId, input.operationId, input.expectedStateVersion],
      );
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
            workflow_version_id
          ) VALUES ($1, $2, $3, $4, $5, 'workflow.activation.complete', 'WORKFLOW', $6, 'SUCCEEDED', $7, $8, $9)
        `,
        [
          randomUUID(),
          operation.tenant_id,
          operation.project_id,
          operation.actor_type,
          operation.actor_id,
          operation.workflow_id,
          operation.correlation_id,
          operation.causation_id,
          operation.target_version_id,
        ],
      );
    });

    const operation = await this.findById(input.tenantId, input.operationId);
    if (operation === undefined) {
      throw new Error('PROVISIONING_OPERATION_INCONSISTENT');
    }
    return operation;
  }

  async findById(
    tenantId: string,
    operationId: string,
  ): Promise<ProvisioningOperationRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT ${operationColumns}
        FROM ${this.operations}
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, operationId],
    )) as OperationRow[];

    return rows[0] === undefined ? undefined : mapOperation(rows[0]);
  }

  private async appendAudit(
    manager: EntityManager,
    input: RequestWorkflowActivationInput,
    action: string,
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
          workflow_version_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'WORKFLOW', $7, 'SUCCEEDED', $8, $9, $10)
      `,
      [
        randomUUID(),
        input.tenantId,
        input.projectId,
        input.actor.type,
        input.actor.id,
        action,
        input.workflowId,
        input.correlationId,
        input.causationId,
        input.targetVersionId,
      ],
    );
  }
}
