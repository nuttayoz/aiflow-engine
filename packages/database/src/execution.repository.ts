import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import type {
  ClaimedExecutionStage,
  ClaimExecutionStageInput,
  CompleteExecutionStageInput,
  CreateExecutionInput,
  ExecutionRecord,
  ExecutionRepository,
  ExecutionStage,
  ExecutionStageSnapshot,
  ExecutionStatus,
  SafeExecutionFailure,
  ScheduleExecutionRetryInput,
  StageAttemptRecord,
} from '@aiflow/executions';
import {
  createMessageEnvelope,
  type MessageEnvelope,
  type MessageType,
} from '@aiflow/messaging';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface ExecutionRow {
  actor_id: string;
  actor_type: ExecutionRecord['actor']['type'];
  causation_id: string;
  completed_at: Date | string | null;
  correlation_id: string;
  created_at: Date | string;
  current_stage: ExecutionStage;
  document_id: string;
  failure_category: SafeExecutionFailure['category'] | null;
  failure_code: string | null;
  failure_message: string | null;
  id: string;
  project_id: string;
  retry_of_execution_id: string | null;
  root_execution_id: string;
  state_version: number | string;
  status: ExecutionStatus;
  tenant_id: string;
  transitioned_at: Date | string;
  workflow_id: string;
  workflow_version_id: string;
}

interface StageRow {
  attempt_count: number | string;
  failure_category: SafeExecutionFailure['category'] | null;
  failure_code: string | null;
  id: string;
  lease_expires_at: Date | string | null;
  lease_owner: string | null;
  next_attempt_at: Date | string | null;
  stage: ExecutionStage;
  state_version: number | string;
  status: ExecutionStageSnapshot['status'];
}

interface AttemptRow {
  attempt_number: number | string;
  finished_at: Date | string | null;
  id: string;
  lease_expires_at: Date | string;
  lease_owner: string;
  output_schema_version: number | null;
  output_storage_object_id: string | null;
  stage: ExecutionStage;
  started_at: Date | string;
  status: StageAttemptRecord['status'];
}

const executionColumns = `
  id,
  tenant_id,
  project_id,
  workflow_id,
  workflow_version_id,
  document_id,
  root_execution_id,
  retry_of_execution_id,
  status,
  current_stage,
  state_version,
  failure_code,
  failure_category,
  failure_message,
  actor_type,
  actor_id,
  correlation_id,
  causation_id,
  created_at,
  transitioned_at,
  completed_at
`;

const safeFailure = (
  code: string | null,
  category: SafeExecutionFailure['category'] | null,
  message: string | null,
): SafeExecutionFailure | undefined =>
  code === null || category === null
    ? undefined
    : {
        category,
        code,
        message: message ?? 'The execution could not complete this stage.',
        retryable: category === 'TRANSIENT',
      };

const commandTypeForStage = (
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

const executionStatusForStage = (stage: ExecutionStage): ExecutionStatus => {
  switch (stage) {
    case 'EXTRACT':
      return 'EXTRACTING';
    case 'MAP':
      return 'MAPPING';
    case 'REVIEW':
      return 'AWAITING_REVIEW';
    case 'DELIVER':
      return 'DELIVERING';
  }
};

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

export class PostgresExecutionRepository implements ExecutionRepository {
  private readonly auditEvents: string;
  private readonly documents: string;
  private readonly executions: string;
  private readonly inboxMessages: string;
  private readonly stages: string;
  private readonly attempts: string;
  private readonly versions: string;
  private readonly workflows: string;
  private readonly outbox: PostgresOutboxRepository;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.auditEvents = table(schema, 'audit_events');
    this.documents = table(schema, 'documents');
    this.executions = table(schema, 'executions');
    this.inboxMessages = table(schema, 'inbox_messages');
    this.stages = table(schema, 'execution_stages');
    this.attempts = table(schema, 'stage_attempts');
    this.versions = table(schema, 'workflow_versions');
    this.workflows = table(schema, 'workflows');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
  }

  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const message = createMessageEnvelope({
      actor: input.actor,
      causationId: input.causationId,
      correlationId: input.correlationId,
      data: {
        executionId: input.executionId,
        expectedStateVersion: 0,
        stage: 'EXTRACT',
      },
      projectId: input.projectId,
      tenantId: input.tenantId,
      type: 'aiflow.execution.stage.extract.requested.v1',
    });

    await this.dataSource.transaction(async (manager) => {
      const intake = (await manager.query(
        `
          SELECT workflow.id
          FROM ${this.workflows} AS workflow
          JOIN ${this.versions} AS version
            ON version.tenant_id = workflow.tenant_id
           AND version.workflow_id = workflow.id
           AND version.id = $4
          JOIN ${this.documents} AS document
            ON document.tenant_id = workflow.tenant_id
           AND document.project_id = workflow.project_id
           AND document.id = $5
          WHERE workflow.tenant_id = $1
            AND workflow.project_id = $2
            AND workflow.id = $3
            AND workflow.active_version_id = version.id
            AND workflow.accepting_new_documents
          FOR UPDATE OF workflow
        `,
        [
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.workflowVersionId,
          input.documentId,
        ],
      )) as { id: string }[];
      if (intake.length !== 1) {
        throw new Error('WORKFLOW_NOT_ACCEPTING_DOCUMENTS');
      }

      await manager.query('SET CONSTRAINTS executions_root_fk DEFERRED');
      await manager.query(
        `
          INSERT INTO ${this.executions} (
            id,
            tenant_id,
            project_id,
            workflow_id,
            workflow_version_id,
            document_id,
            root_execution_id,
            status,
            current_stage,
            actor_type,
            actor_id,
            correlation_id,
            causation_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $1, 'QUEUED', 'EXTRACT', $7, $8, $9, $10)
        `,
        [
          input.executionId,
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.workflowVersionId,
          input.documentId,
          input.actor.type,
          input.actor.id,
          input.correlationId,
          input.causationId,
        ],
      );

      for (const stage of ['EXTRACT', 'MAP', 'REVIEW', 'DELIVER'] as const) {
        await manager.query(
          `
            INSERT INTO ${this.stages} (
              id, tenant_id, execution_id, stage, status
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [
            randomUUID(),
            input.tenantId,
            input.executionId,
            stage,
            stage === 'REVIEW' && !input.reviewRequired ? 'SKIPPED' : 'PENDING',
          ],
        );
      }

      await this.outbox.append(queryRunner(manager), {
        aggregateId: input.executionId,
        aggregateType: 'EXECUTION',
        envelope: message,
      });
      await this.appendAudit(manager, {
        action: 'execution.create',
        actorId: input.actor.id,
        actorType: input.actor.type,
        causationId: input.causationId,
        correlationId: input.correlationId,
        executionId: input.executionId,
        projectId: input.projectId,
        tenantId: input.tenantId,
        workflowVersionId: input.workflowVersionId,
      });
    });

    const execution = await this.findById(input.tenantId, input.executionId);
    if (execution === undefined) {
      throw new Error('EXECUTION_CREATE_INCONSISTENT');
    }
    return execution;
  }

  async claimStage(
    input: ClaimExecutionStageInput,
  ): Promise<ClaimedExecutionStage | undefined> {
    if (
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 900_000
    ) {
      throw new Error('LEASE_DURATION_INVALID');
    }

    const attempt = await this.dataSource.transaction(async (manager) => {
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
          ) VALUES ($1, $2, $3, $4, $5, $6, 'EXECUTION', $7, 'CLAIMED', clock_timestamp() + interval '90 days')
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
          input.executionId,
        ],
      )) as { id: string }[];
      if (inbox.length === 0) {
        return undefined;
      }

      const executions = (await manager.query(
        `
          SELECT ${executionColumns}
          FROM ${this.executions}
          WHERE tenant_id = $1
            AND project_id = $2
            AND id = $3
            AND state_version = $4
            AND current_stage = $5
            AND status NOT IN ('SUCCEEDED', 'FAILED', 'REJECTED')
          FOR UPDATE
        `,
        [
          input.tenantId,
          input.projectId,
          input.executionId,
          input.expectedStateVersion,
          input.stage,
        ],
      )) as ExecutionRow[];
      if (executions.length === 0) {
        await this.markInboxStale(manager, input.consumerName, input.messageId);
        return undefined;
      }

      const stages = mutationRows<StageRow>(
        await manager.query(
          `
          UPDATE ${this.stages}
          SET status = 'RUNNING',
              attempt_count = attempt_count + 1,
              state_version = state_version + 1,
              next_attempt_at = NULL,
              lease_owner = $4,
              lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'),
              failure_code = NULL,
              failure_category = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND execution_id = $2
            AND stage = $3
            AND (
              status = 'PENDING'
              OR (status = 'RETRY_SCHEDULED' AND next_attempt_at <= clock_timestamp())
            )
          RETURNING
            id,
            stage,
            status,
            attempt_count,
            state_version,
            next_attempt_at,
            lease_owner,
            lease_expires_at,
            failure_code,
            failure_category
        `,
          [
            input.tenantId,
            input.executionId,
            input.stage,
            input.leaseOwner,
            input.leaseDurationMs,
          ],
        ),
      );
      const stage = stages[0];
      if (stage === undefined || stage.lease_expires_at === null) {
        await this.markInboxStale(manager, input.consumerName, input.messageId);
        return undefined;
      }

      await manager.query(
        `
          UPDATE ${this.executions}
          SET status = $4,
              state_version = state_version + 1,
              started_at = COALESCE(started_at, clock_timestamp()),
              transitioned_at = clock_timestamp(),
              failure_code = NULL,
              failure_category = NULL,
              failure_message = NULL
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [
          input.tenantId,
          input.executionId,
          input.expectedStateVersion,
          executionStatusForStage(input.stage),
        ],
      );
      const attemptId = randomUUID();
      const attempts = mutationRows<{ id: string }>(
        await manager.query(
          `
          INSERT INTO ${this.attempts} (
            id,
            tenant_id,
            execution_id,
            execution_stage_id,
            stage,
            attempt_number,
            status,
            lease_owner,
            lease_expires_at,
            started_at
          ) VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', $7, $8, clock_timestamp())
          RETURNING
            id,
            stage,
            attempt_number,
            status,
            lease_owner,
            lease_expires_at,
            started_at,
            finished_at,
            output_storage_object_id,
            output_schema_version
        `,
          [
            attemptId,
            input.tenantId,
            input.executionId,
            stage.id,
            input.stage,
            Number(stage.attempt_count),
            input.leaseOwner,
            stage.lease_expires_at,
          ],
        ),
      ) as AttemptRow[];

      return this.mapAttempt(input.tenantId, input.executionId, attempts[0]);
    });

    if (attempt === undefined) {
      return undefined;
    }
    const execution = await this.findById(input.tenantId, input.executionId);
    if (execution === undefined) {
      throw new Error('EXECUTION_CLAIM_INCONSISTENT');
    }
    return { attempt, execution };
  }

  async completeStage(
    input: CompleteExecutionStageInput,
  ): Promise<ExecutionRecord> {
    await this.dataSource.transaction(async (manager) => {
      const execution = await this.lockExecution(
        manager,
        input.tenantId,
        input.executionId,
        input.expectedStateVersion,
        input.stage,
      );
      const stage = await this.lockRunningStage(
        manager,
        input.tenantId,
        input.executionId,
        input.stage,
        input.leaseOwner,
      );

      const nextStage = await this.nextStage(manager, execution, input.stage);
      const nextStateVersion = input.expectedStateVersion + 1;
      const terminal = nextStage === undefined;

      const attempts = mutationRows<{ id: string }>(
        await manager.query(
          `
          UPDATE ${this.attempts}
          SET status = 'SUCCEEDED',
              finished_at = clock_timestamp(),
              output_storage_object_id = $6,
              output_schema_version = $7
          WHERE tenant_id = $1
            AND execution_id = $2
            AND execution_stage_id = $3
            AND attempt_number = $4
            AND lease_owner = $5
            AND status = 'RUNNING'
          RETURNING id
        `,
          [
            input.tenantId,
            input.executionId,
            stage.id,
            Number(stage.attempt_count),
            input.leaseOwner,
            input.outputStorageObjectId ?? null,
            input.outputSchemaVersion ?? null,
          ],
        ),
      );
      if (attempts.length !== 1) {
        throw new Error('STAGE_ATTEMPT_CONFLICT');
      }

      await manager.query(
        `
          UPDATE ${this.stages}
          SET status = 'SUCCEEDED',
              state_version = state_version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              failure_code = NULL,
              failure_category = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2
        `,
        [input.tenantId, stage.id],
      );
      await manager.query(
        `
          UPDATE ${this.executions}
          SET status = $4,
              current_stage = $5,
              state_version = state_version + 1,
              failure_code = NULL,
              failure_category = NULL,
              failure_message = NULL,
              transitioned_at = clock_timestamp(),
              completed_at = CASE WHEN $6 THEN clock_timestamp() ELSE NULL END
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [
          input.tenantId,
          input.executionId,
          input.expectedStateVersion,
          terminal ? 'SUCCEEDED' : executionStatusForStage(nextStage),
          terminal ? input.stage : nextStage,
          terminal,
        ],
      );

      if (nextStage !== undefined) {
        const connectorId =
          nextStage === 'DELIVER'
            ? await this.destinationConnectorId(manager, execution)
            : undefined;
        const message = this.stageMessage(
          execution,
          nextStage,
          nextStateVersion,
          input.causationId,
          connectorId,
        );
        await this.outbox.append(queryRunner(manager), {
          aggregateId: execution.id,
          aggregateType: 'EXECUTION',
          envelope: message,
        });
      }
      await this.appendAudit(manager, {
        action: terminal ? 'execution.succeed' : 'execution.stage.complete',
        actorId: execution.actor_id,
        actorType: execution.actor_type,
        causationId: input.causationId,
        correlationId: execution.correlation_id,
        executionId: execution.id,
        projectId: execution.project_id,
        tenantId: execution.tenant_id,
        workflowVersionId: execution.workflow_version_id,
      });
    });

    const execution = await this.findById(input.tenantId, input.executionId);
    if (execution === undefined) {
      throw new Error('EXECUTION_COMPLETE_INCONSISTENT');
    }
    return execution;
  }

  async scheduleRetry(
    input: ScheduleExecutionRetryInput,
  ): Promise<ExecutionRecord> {
    if (
      !input.failure.retryable ||
      input.failure.category !== 'TRANSIENT' ||
      input.nextAttemptAt.getTime() <= Date.now()
    ) {
      throw new Error('EXECUTION_RETRY_INVALID');
    }

    await this.dataSource.transaction(async (manager) => {
      const execution = await this.lockExecution(
        manager,
        input.tenantId,
        input.executionId,
        input.expectedStateVersion,
        input.stage,
      );
      const stage = await this.lockRunningStage(
        manager,
        input.tenantId,
        input.executionId,
        input.stage,
        input.leaseOwner,
      );
      await manager.query(
        `
          UPDATE ${this.attempts}
          SET status = 'FAILED',
              finished_at = clock_timestamp(),
              failure_code = $6,
              failure_category = $7
          WHERE tenant_id = $1
            AND execution_id = $2
            AND execution_stage_id = $3
            AND attempt_number = $4
            AND lease_owner = $5
            AND status = 'RUNNING'
        `,
        [
          input.tenantId,
          input.executionId,
          stage.id,
          Number(stage.attempt_count),
          input.leaseOwner,
          input.failure.code,
          input.failure.category,
        ],
      );
      await manager.query(
        `
          UPDATE ${this.stages}
          SET status = 'RETRY_SCHEDULED',
              state_version = state_version + 1,
              next_attempt_at = $3,
              lease_owner = NULL,
              lease_expires_at = NULL,
              failure_code = $4,
              failure_category = $5,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2
        `,
        [
          input.tenantId,
          stage.id,
          input.nextAttemptAt,
          input.failure.code,
          input.failure.category,
        ],
      );
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
          input.tenantId,
          input.executionId,
          input.expectedStateVersion,
          input.failure.code,
          input.failure.category,
          input.failure.message,
        ],
      );
      await this.appendAudit(manager, {
        action: 'execution.stage.retry.schedule',
        actorId: execution.actor_id,
        actorType: execution.actor_type,
        causationId: execution.causation_id,
        correlationId: execution.correlation_id,
        executionId: execution.id,
        projectId: execution.project_id,
        tenantId: execution.tenant_id,
        workflowVersionId: execution.workflow_version_id,
      });
    });

    const execution = await this.findById(input.tenantId, input.executionId);
    if (execution === undefined) {
      throw new Error('EXECUTION_RETRY_INCONSISTENT');
    }
    return execution;
  }

  async findById(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionRecord | undefined> {
    const executions = (await this.dataSource.query(
      `SELECT ${executionColumns} FROM ${this.executions} WHERE tenant_id = $1 AND id = $2`,
      [tenantId, executionId],
    )) as ExecutionRow[];
    const execution = executions[0];
    if (execution === undefined) {
      return undefined;
    }
    const stageRows = (await this.dataSource.query(
      `
        SELECT
          id,
          stage,
          status,
          attempt_count,
          state_version,
          next_attempt_at,
          lease_owner,
          lease_expires_at,
          failure_code,
          failure_category
        FROM ${this.stages}
        WHERE tenant_id = $1 AND execution_id = $2
      `,
      [tenantId, executionId],
    )) as StageRow[];

    const stages = Object.fromEntries(
      stageRows.map((stage) => [
        stage.stage,
        {
          attemptCount: Number(stage.attempt_count),
          ...(safeFailure(
            stage.failure_code,
            stage.failure_category,
            execution.failure_message,
          ) === undefined
            ? {}
            : {
                failure: safeFailure(
                  stage.failure_code,
                  stage.failure_category,
                  execution.failure_message,
                ),
              }),
          ...(stage.lease_expires_at === null
            ? {}
            : { leaseExpiresAt: new Date(stage.lease_expires_at) }),
          ...(stage.lease_owner === null
            ? {}
            : { leaseOwner: stage.lease_owner }),
          ...(stage.next_attempt_at === null
            ? {}
            : { nextAttemptAt: new Date(stage.next_attempt_at) }),
          stage: stage.stage,
          stateVersion: Number(stage.state_version),
          status: stage.status,
        },
      ]),
    ) as Record<ExecutionStage, ExecutionStageSnapshot>;
    if (Object.keys(stages).length !== 4) {
      throw new Error('EXECUTION_STAGE_SET_INVALID');
    }

    return {
      actor: { id: execution.actor_id, type: execution.actor_type },
      causationId: execution.causation_id,
      ...(execution.completed_at === null
        ? {}
        : { completedAt: new Date(execution.completed_at) }),
      correlationId: execution.correlation_id,
      createdAt: new Date(execution.created_at),
      currentStage: execution.current_stage,
      documentId: execution.document_id,
      executionId: execution.id,
      ...(safeFailure(
        execution.failure_code,
        execution.failure_category,
        execution.failure_message,
      ) === undefined
        ? {}
        : {
            failure: safeFailure(
              execution.failure_code,
              execution.failure_category,
              execution.failure_message,
            ),
          }),
      projectId: execution.project_id,
      ...(execution.retry_of_execution_id === null
        ? {}
        : { retryOfExecutionId: execution.retry_of_execution_id }),
      reviewRequired: stages.REVIEW.status !== 'SKIPPED',
      rootExecutionId: execution.root_execution_id,
      stages,
      stateVersion: Number(execution.state_version),
      status: execution.status,
      tenantId: execution.tenant_id,
      transitionedAt: new Date(execution.transitioned_at),
      workflowId: execution.workflow_id,
      workflowVersionId: execution.workflow_version_id,
    };
  }

  private async lockExecution(
    manager: EntityManager,
    tenantId: string,
    executionId: string,
    expectedStateVersion: number,
    stage: ExecutionStage,
  ): Promise<ExecutionRow> {
    const rows = (await manager.query(
      `
        SELECT ${executionColumns}
        FROM ${this.executions}
        WHERE tenant_id = $1
          AND id = $2
          AND state_version = $3
          AND current_stage = $4
          AND status NOT IN ('SUCCEEDED', 'FAILED', 'REJECTED')
        FOR UPDATE
      `,
      [tenantId, executionId, expectedStateVersion, stage],
    )) as ExecutionRow[];
    if (rows[0] === undefined) {
      throw new Error('EXECUTION_TRANSITION_CONFLICT');
    }
    return rows[0];
  }

  private async lockRunningStage(
    manager: EntityManager,
    tenantId: string,
    executionId: string,
    stage: ExecutionStage,
    leaseOwner: string,
  ): Promise<StageRow> {
    const rows = (await manager.query(
      `
        SELECT
          id,
          stage,
          status,
          attempt_count,
          state_version,
          next_attempt_at,
          lease_owner,
          lease_expires_at,
          failure_code,
          failure_category
        FROM ${this.stages}
        WHERE tenant_id = $1
          AND execution_id = $2
          AND stage = $3
          AND status = 'RUNNING'
          AND lease_owner = $4
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `,
      [tenantId, executionId, stage, leaseOwner],
    )) as StageRow[];
    if (rows[0] === undefined) {
      throw new Error('STAGE_LEASE_LOST');
    }
    return rows[0];
  }

  private async nextStage(
    manager: EntityManager,
    execution: ExecutionRow,
    stage: ExecutionStage,
  ): Promise<ExecutionStage | undefined> {
    switch (stage) {
      case 'EXTRACT':
        return 'MAP';
      case 'MAP': {
        const reviews = (await manager.query(
          `
            SELECT status
            FROM ${this.stages}
            WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'REVIEW'
          `,
          [execution.tenant_id, execution.id],
        )) as { status: ExecutionStageSnapshot['status'] }[];
        return reviews[0]?.status === 'SKIPPED' ? 'DELIVER' : 'REVIEW';
      }
      case 'REVIEW':
        return 'DELIVER';
      case 'DELIVER':
        return undefined;
    }
  }

  private async destinationConnectorId(
    manager: EntityManager,
    execution: ExecutionRow,
  ): Promise<string> {
    const rows = (await manager.query(
      `
        SELECT definition #>> '{destination,connectorId}' AS connector_id
        FROM ${this.versions}
        WHERE tenant_id = $1 AND id = $2
      `,
      [execution.tenant_id, execution.workflow_version_id],
    )) as { connector_id: string | null }[];
    const connectorId = rows[0]?.connector_id;
    if (connectorId === null || connectorId === undefined) {
      throw new Error('DESTINATION_CONNECTOR_MISSING');
    }
    return connectorId;
  }

  private stageMessage(
    execution: ExecutionRow,
    stage: ExecutionStage,
    expectedStateVersion: number,
    causationId: string,
    connectorId?: string,
  ): MessageEnvelope {
    return createMessageEnvelope({
      actor: { id: execution.actor_id, type: execution.actor_type },
      causationId,
      correlationId: execution.correlation_id,
      data: {
        ...(connectorId === undefined ? {} : { connectorId }),
        executionId: execution.id,
        expectedStateVersion,
        stage,
      },
      projectId: execution.project_id,
      tenantId: execution.tenant_id,
      type: commandTypeForStage(stage, connectorId),
    });
  }

  private async markInboxStale(
    manager: EntityManager,
    consumerName: string,
    messageId: string,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE ${this.inboxMessages}
        SET outcome = 'STALE', completed_at = clock_timestamp()
        WHERE consumer_name = $1 AND message_id = $2
      `,
      [consumerName, messageId],
    );
  }

  private mapAttempt(
    tenantId: string,
    executionId: string,
    row: AttemptRow,
  ): StageAttemptRecord {
    return {
      attemptId: row.id,
      attemptNumber: Number(row.attempt_number),
      executionId,
      ...(row.finished_at === null
        ? {}
        : { finishedAt: new Date(row.finished_at) }),
      leaseExpiresAt: new Date(row.lease_expires_at),
      leaseOwner: row.lease_owner,
      ...(row.output_schema_version === null
        ? {}
        : { outputSchemaVersion: row.output_schema_version }),
      ...(row.output_storage_object_id === null
        ? {}
        : { outputStorageObjectId: row.output_storage_object_id }),
      stage: row.stage,
      startedAt: new Date(row.started_at),
      status: row.status,
      tenantId,
    };
  }

  private async appendAudit(
    manager: EntityManager,
    input: {
      readonly action: string;
      readonly actorId: string;
      readonly actorType: ExecutionRecord['actor']['type'];
      readonly causationId: string;
      readonly correlationId: string;
      readonly executionId: string;
      readonly projectId: string;
      readonly tenantId: string;
      readonly workflowVersionId: string;
    },
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
        ) VALUES ($1, $2, $3, $4, $5, $6, 'EXECUTION', $7, 'SUCCEEDED', $8, $9, $10)
      `,
      [
        randomUUID(),
        input.tenantId,
        input.projectId,
        input.actorType,
        input.actorId,
        input.action,
        input.executionId,
        input.correlationId,
        input.causationId,
        input.workflowVersionId,
      ],
    );
  }
}
