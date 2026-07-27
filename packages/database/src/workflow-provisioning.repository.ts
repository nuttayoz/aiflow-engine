import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import { createMessageEnvelope } from '@aiflow/messaging';
import type {
  ClaimProvisioningOperationInput,
  ProvisioningOperationRecord,
  RequestWorkflowActivationInput,
  RequestWorkflowDeactivationInput,
  WorkflowDeactivationResult,
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

interface WorkflowActivationRow {
  accepting_new_documents: boolean;
  active_version_id: string | null;
  cleanup_required: boolean;
  health: WorkflowDeactivationResult['health'];
  status: 'ACTIVE' | 'ARCHIVED' | 'INACTIVE';
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

const deactivationFingerprint = (
  input: RequestWorkflowDeactivationInput,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        projectId: input.projectId,
        workflowId: input.workflowId,
      }),
    )
    .digest('hex');

const parseDeactivationResult = (
  value: unknown,
): WorkflowDeactivationResult => {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('workflowId' in parsed) ||
    typeof parsed.workflowId !== 'string' ||
    !('acceptingNewDocuments' in parsed) ||
    typeof parsed.acceptingNewDocuments !== 'boolean' ||
    !('cleanupRequired' in parsed) ||
    typeof parsed.cleanupRequired !== 'boolean' ||
    !('health' in parsed) ||
    !['DEGRADED', 'HEALTHY', 'UNKNOWN'].includes(String(parsed.health)) ||
    ('operationId' in parsed && typeof parsed.operationId !== 'string')
  ) {
    throw new Error('WORKFLOW_DEACTIVATION_IDEMPOTENCY_INCONSISTENT');
  }
  return parsed as unknown as WorkflowDeactivationResult;
};

export class PostgresWorkflowProvisioningRepository implements WorkflowProvisioningRepository {
  private readonly auditEvents: string;
  private readonly bindings: string;
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
    this.bindings = table(schema, 'connector_provisioning_bindings');
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
            workflow.status AS workflow_status,
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
        workflow_status: 'ACTIVE' | 'ARCHIVED' | 'INACTIVE';
      }[];
      const target = targets[0];
      if (target === undefined) {
        throw new Error('WORKFLOW_VERSION_NOT_FOUND');
      }
      if (target.workflow_status === 'ARCHIVED') {
        throw new Error('WORKFLOW_ARCHIVED');
      }

      const current = (await manager.query(
        `
          SELECT id
          FROM ${this.operations}
          WHERE tenant_id = $1
            AND workflow_id = $2
            AND status IN ('PENDING', 'RUNNING', 'WAITING_RETRY', 'RECONCILING')
          LIMIT 1
        `,
        [input.tenantId, input.workflowId],
      )) as { id: string }[];
      if (current.length > 0) {
        throw new Error('WORKFLOW_PROVISIONING_IN_PROGRESS');
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

  async requestDeactivation(
    input: RequestWorkflowDeactivationInput,
  ): Promise<WorkflowDeactivationResult> {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    }
    const fingerprint = deactivationFingerprint(input);

    return this.dataSource.transaction(async (manager) => {
      const workflows = (await manager.query(
        `
          SELECT
            active_version_id,
            accepting_new_documents,
            cleanup_required,
            health,
            status
          FROM ${this.workflows}
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          FOR UPDATE
        `,
        [input.tenantId, input.projectId, input.workflowId],
      )) as WorkflowActivationRow[];
      const workflow = workflows[0];
      if (workflow === undefined) {
        throw new Error('WORKFLOW_NOT_FOUND');
      }

      const existing = (await manager.query(
        `
          SELECT request_fingerprint, response
          FROM ${this.idempotency}
          WHERE tenant_id = $1
            AND operation_scope = 'workflow.deactivate'
            AND idempotency_key = $2
          FOR UPDATE
        `,
        [input.tenantId, input.idempotencyKey],
      )) as { request_fingerprint: string; response: unknown }[];
      if (existing[0] !== undefined) {
        if (existing[0].request_fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        return parseDeactivationResult(existing[0].response);
      }
      if (workflow.status === 'ARCHIVED') {
        throw new Error('WORKFLOW_ARCHIVED');
      }

      const current = (await manager.query(
        `
          SELECT id
          FROM ${this.operations}
          WHERE tenant_id = $1
            AND workflow_id = $2
            AND status IN ('PENDING', 'RUNNING', 'WAITING_RETRY', 'RECONCILING')
          LIMIT 1
          FOR UPDATE
        `,
        [input.tenantId, input.workflowId],
      )) as { id: string }[];
      if (current.length > 0) {
        throw new Error('WORKFLOW_PROVISIONING_IN_PROGRESS');
      }
      if (workflow.cleanup_required) {
        throw new Error('WORKFLOW_DEACTIVATION_CLEANUP_UNAVAILABLE');
      }

      const bindings =
        workflow.active_version_id === null
          ? []
          : ((await manager.query(
              `
                SELECT id
                FROM ${this.bindings}
                WHERE tenant_id = $1
                  AND project_id = $2
                  AND workflow_id = $3
                  AND workflow_version_id = $4
                  AND status IN ('ACTIVE', 'DRAINING')
                FOR UPDATE
              `,
              [
                input.tenantId,
                input.projectId,
                input.workflowId,
                workflow.active_version_id,
              ],
            )) as { id: string }[]);
      const managedCleanup = bindings.length > 0;
      const changed =
        workflow.status === 'ACTIVE' ||
        workflow.active_version_id !== null ||
        workflow.accepting_new_documents;

      if (managedCleanup) {
        await manager.query(
          `
            UPDATE ${this.bindings}
            SET status = 'DRAINING',
                accepting_new_documents = false,
                drain_deadline_at = clock_timestamp() + interval '15 minutes',
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND project_id = $2
              AND workflow_id = $3
              AND workflow_version_id = $4
              AND status IN ('ACTIVE', 'DRAINING')
          `,
          [
            input.tenantId,
            input.projectId,
            input.workflowId,
            workflow.active_version_id,
          ],
        );
        await manager.query(
          `
            UPDATE ${this.workflows}
            SET accepting_new_documents = false,
                cleanup_required = true,
                health = 'UNKNOWN',
                status = 'INACTIVE',
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          `,
          [input.tenantId, input.projectId, input.workflowId],
        );
        await manager.query(
          `
            INSERT INTO ${this.operations} (
              id,
              tenant_id,
              project_id,
              workflow_id,
              previous_version_id,
              kind,
              status,
              current_step,
              actor_type,
              actor_id,
              correlation_id,
              causation_id
            ) VALUES (
              $1, $2, $3, $4, $5, 'DEACTIVATE', 'PENDING', 'DEPROVISION',
              $6, $7, $8, $9
            )
          `,
          [
            input.operationId,
            input.tenantId,
            input.projectId,
            input.workflowId,
            workflow.active_version_id,
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
      } else if (changed) {
        await manager.query(
          `
            UPDATE ${this.workflows}
            SET active_version_id = NULL,
                accepting_new_documents = false,
                cleanup_required = false,
                health = 'UNKNOWN',
                status = 'INACTIVE',
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          `,
          [input.tenantId, input.projectId, input.workflowId],
        );
      }

      const result: WorkflowDeactivationResult = {
        acceptingNewDocuments: false,
        ...(!managedCleanup || workflow.active_version_id === null
          ? {}
          : { activeVersionId: workflow.active_version_id }),
        cleanupRequired: managedCleanup,
        health: changed ? 'UNKNOWN' : workflow.health,
        ...(managedCleanup ? { operationId: input.operationId } : {}),
        workflowId: input.workflowId,
      };
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
            response,
            completed_at,
            expires_at
          ) VALUES (
            $1, $2, 'workflow.deactivate', $3, $4, 'COMPLETED',
            'WORKFLOW', $5, $6::jsonb, clock_timestamp(),
            clock_timestamp() + interval '90 days'
          )
          ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
          RETURNING id
        `,
        [
          randomUUID(),
          input.tenantId,
          input.idempotencyKey,
          fingerprint,
          input.workflowId,
          JSON.stringify(result),
        ],
      )) as { id: string }[];
      if (inserted.length === 0) {
        const concurrent = (await manager.query(
          `
            SELECT request_fingerprint, response
            FROM ${this.idempotency}
            WHERE tenant_id = $1
              AND operation_scope = 'workflow.deactivate'
              AND idempotency_key = $2
            FOR UPDATE
          `,
          [input.tenantId, input.idempotencyKey],
        )) as { request_fingerprint: string; response: unknown }[];
        if (concurrent[0]?.request_fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        return parseDeactivationResult(concurrent[0]?.response);
      }

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
          changed
            ? managedCleanup
              ? 'workflow.deactivation.request'
              : 'workflow.deactivation.complete'
            : 'workflow.deactivation.noop',
          input.workflowId,
          input.correlationId,
          input.causationId,
          workflow.active_version_id,
        ],
      );
      return result;
    });
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
    readonly managedBindingId?: string;
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

      if (input.managedBindingId !== undefined) {
        const bindings = mutationRows<{ id: string }>(
          await manager.query(
            `
              UPDATE ${this.bindings}
              SET status = 'ACTIVE',
                  health = 'HEALTHY',
                  accepting_new_documents = true,
                  state_version = state_version + 1,
                  failure_code = NULL,
                  updated_at = clock_timestamp()
              WHERE tenant_id = $1
                AND project_id = $2
                AND workflow_id = $3
                AND workflow_version_id = $4
                AND id = $5
                AND status = 'PREPARING'
              RETURNING id
            `,
            [
              operation.tenant_id,
              operation.project_id,
              operation.workflow_id,
              operation.target_version_id,
              input.managedBindingId,
            ],
          ),
        );
        if (bindings.length !== 1) {
          throw new Error('MANAGED_CONNECTOR_BINDING_NOT_READY');
        }
        await manager.query(
          `
            UPDATE ${this.bindings}
            SET status = 'DRAINING',
                accepting_new_documents = false,
                drain_deadline_at = clock_timestamp() + interval '15 minutes',
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND project_id = $2
              AND workflow_id = $3
              AND workflow_version_id <> $4
              AND status = 'ACTIVE'
          `,
          [
            operation.tenant_id,
            operation.project_id,
            operation.workflow_id,
            operation.target_version_id,
          ],
        );
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

  async completeDeactivation(input: {
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
            AND kind = 'DEACTIVATE'
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
      if (operation === undefined) {
        throw new Error('PROVISIONING_LEASE_LOST');
      }

      const workflows = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.workflows}
            SET active_version_id = NULL,
                accepting_new_documents = false,
                cleanup_required = false,
                status = 'INACTIVE',
                health = 'UNKNOWN',
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND project_id = $2
              AND id = $3
            RETURNING id
          `,
          [operation.tenant_id, operation.project_id, operation.workflow_id],
        ),
      );
      if (workflows.length !== 1) {
        throw new Error('WORKFLOW_DEACTIVATION_CONFLICT');
      }
      const completed = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.operations}
            SET status = 'SUCCEEDED',
                current_step = 'DEPROVISION',
                state_version = state_version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND state_version = $3
            RETURNING id
          `,
          [input.tenantId, input.operationId, input.expectedStateVersion],
        ),
      );
      if (completed.length !== 1) {
        throw new Error('PROVISIONING_LEASE_LOST');
      }
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
          ) VALUES (
            $1, $2, $3, $4, $5, 'workflow.deactivation.complete',
            'WORKFLOW', $6, 'SUCCEEDED', $7, $8, $9
          )
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
          operation.previous_version_id,
        ],
      );
    });

    const operation = await this.findById(input.tenantId, input.operationId);
    if (operation === undefined) {
      throw new Error('PROVISIONING_OPERATION_INCONSISTENT');
    }
    return operation;
  }

  async deferActivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord> {
    return this.deferOperation(input, 'PROVISION');
  }

  async deferDeactivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord> {
    return this.deferOperation(input, 'DEPROVISION');
  }

  private async deferOperation(
    input: {
      readonly expectedStateVersion: number;
      readonly leaseOwner: string;
      readonly nextAttemptAt: Date;
      readonly operationId: string;
      readonly tenantId: string;
    },
    currentStep: 'DEPROVISION' | 'PROVISION',
  ): Promise<ProvisioningOperationRecord> {
    if (
      !Number.isFinite(input.nextAttemptAt.getTime()) ||
      input.nextAttemptAt.getTime() <= Date.now() ||
      input.nextAttemptAt.getTime() > Date.now() + 24 * 60 * 60 * 1_000
    ) {
      throw new Error('PROVISIONING_RETRY_AT_INVALID');
    }
    const row = await this.dataSource.transaction(async (manager) => {
      const rows = mutationRows<OperationRow>(
        await manager.query(
          `
            UPDATE ${this.operations}
            SET status = 'WAITING_RETRY',
                current_step = $6,
                state_version = state_version + 1,
                next_attempt_at = $5,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND state_version = $3
              AND status = 'RUNNING'
              AND lease_owner = $4
              AND lease_expires_at > clock_timestamp()
            RETURNING ${operationColumns}
          `,
          [
            input.tenantId,
            input.operationId,
            input.expectedStateVersion,
            input.leaseOwner,
            input.nextAttemptAt,
            currentStep,
          ],
        ),
      );
      const operation = rows[0];
      if (operation === undefined) {
        throw new Error('PROVISIONING_LEASE_LOST');
      }
      const message = createMessageEnvelope({
        actor: { id: operation.actor_id, type: operation.actor_type },
        causationId: operation.id,
        correlationId: operation.correlation_id,
        data: {
          expectedStateVersion: Number(operation.state_version),
          provisioningOperationId: operation.id,
        },
        occurredAt: new Date(),
        projectId: operation.project_id,
        tenantId: operation.tenant_id,
        type: 'aiflow.workflow.provisioning.requested.v1',
      });
      if (manager.queryRunner === undefined) {
        throw new Error('DATABASE_TRANSACTION_REQUIRED');
      }
      await this.outbox.append(manager.queryRunner, {
        aggregateId: operation.id,
        aggregateType: 'PROVISIONING_OPERATION',
        availableAt: input.nextAttemptAt,
        envelope: message,
      });
      return operation;
    });
    return mapOperation(row);
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

  async findCurrentByWorkflow(
    tenantId: string,
    workflowId: string,
  ): Promise<ProvisioningOperationRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT ${operationColumns}
        FROM ${this.operations}
        WHERE tenant_id = $1
          AND workflow_id = $2
          AND status IN ('PENDING', 'RUNNING', 'WAITING_RETRY', 'RECONCILING')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [tenantId, workflowId],
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

export class PostgresWorkflowProvisioningRecoveryRepository {
  private readonly operations: string;
  private readonly outbox: PostgresOutboxRepository;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.operations = table(schema, 'workflow_activation_operations');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
  }

  async recoverExpiredLeases(batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new Error('RECOVERY_BATCH_SIZE_INVALID');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT
            id,
            tenant_id,
            project_id,
            correlation_id
          FROM ${this.operations}
          WHERE status = 'RUNNING'
            AND lease_expires_at <= clock_timestamp()
          ORDER BY lease_expires_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [batchSize],
      )) as {
        correlation_id: string;
        id: string;
        project_id: string;
        tenant_id: string;
      }[];
      if (manager.queryRunner === undefined) {
        throw new Error('DATABASE_TRANSACTION_REQUIRED');
      }
      for (const row of rows) {
        const recovered = mutationRows<{
          next_attempt_at: Date | string;
          state_version: number | string;
        }>(
          await manager.query(
            `
              UPDATE ${this.operations}
              SET status = 'WAITING_RETRY',
                  current_step = CASE
                    WHEN kind = 'DEACTIVATE' THEN 'DEPROVISION'
                    ELSE 'PROVISION'
                  END,
                  state_version = state_version + 1,
                  next_attempt_at = clock_timestamp() + interval '1 second',
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  failure_code = 'PROVISIONING_LEASE_EXPIRED',
                  failure_category = 'TRANSIENT',
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
          actor: { id: 'workflow-provisioning-scheduler', type: 'SYSTEM' },
          causationId: row.id,
          correlationId: row.correlation_id,
          data: {
            expectedStateVersion: Number(recovered.state_version),
            provisioningOperationId: row.id,
          },
          occurredAt: retryAt,
          projectId: row.project_id,
          tenantId: row.tenant_id,
          type: 'aiflow.workflow.provisioning.requested.v1',
        });
        await this.outbox.append(manager.queryRunner, {
          aggregateId: row.id,
          aggregateType: 'PROVISIONING_OPERATION',
          availableAt: retryAt,
          envelope,
        });
      }
      return rows.length;
    });
  }
}
