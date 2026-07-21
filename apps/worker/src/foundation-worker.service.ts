import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { directUploadConnector } from '@aiflow/connector-direct-upload';
import { phase1SyntheticConnector } from '@aiflow/connector-phase1-synthetic';
import { ConnectorRegistry } from '@aiflow/connector-sdk';
import {
  DatabaseService,
  PostgresExecutionRepository,
  PostgresWorkflowProvisioningRepository,
  PostgresWorkflowRepository,
} from '@aiflow/database';
import {
  RABBIT_MQ_CLIENT,
  type MessageEnvelope,
  type MessageHandler,
  type MessageHandlingOutcome,
  type RabbitMqClient,
} from '@aiflow/messaging';
import { WorkflowProvisioningService } from '@aiflow/workflows';
import { RuntimeTelemetry } from '@aiflow/observability';

import { SYNTHETIC_STAGES_ENABLED, WORKER_QUEUE_NAMES } from './worker.tokens';

const MESSAGE_TYPES = [
  'aiflow.workflow.provisioning.requested.v1',
  'aiflow.execution.stage.extract.requested.v1',
  'aiflow.execution.stage.map.requested.v1',
  'aiflow.execution.stage.deliver.connector.phase1-synthetic.requested.v1',
] as const;

interface ProvisioningData extends Readonly<Record<string, unknown>> {
  readonly expectedStateVersion: number;
  readonly provisioningOperationId: string;
}

interface StageData extends Readonly<Record<string, unknown>> {
  readonly executionId: string;
  readonly expectedStateVersion: number;
  readonly stage: 'DELIVER' | 'EXTRACT' | 'MAP';
}

@Injectable()
export class FoundationWorkerService
  implements MessageHandler, OnApplicationBootstrap
{
  readonly messageTypes = MESSAGE_TYPES;
  private readonly consumerName = `phase1-worker:${randomUUID()}`;
  private executions?: PostgresExecutionRepository;
  private provisioning?: WorkflowProvisioningService;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RABBIT_MQ_CLIENT) private readonly rabbitMq: RabbitMqClient,
    @Inject(WORKER_QUEUE_NAMES) private readonly queueNames: readonly string[],
    @Inject(SYNTHETIC_STAGES_ENABLED)
    private readonly syntheticStagesEnabled: boolean,
    @Inject(RuntimeTelemetry) private readonly telemetry: RuntimeTelemetry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schema = this.database.schema;
    const workflows = new PostgresWorkflowRepository(
      this.database.dataSource,
      schema,
    );
    this.executions = new PostgresExecutionRepository(
      this.database.dataSource,
      schema,
    );
    this.provisioning = new WorkflowProvisioningService(
      new PostgresWorkflowProvisioningRepository(
        this.database.dataSource,
        schema,
      ),
      workflows,
      new ConnectorRegistry([directUploadConnector, phase1SyntheticConnector]),
    );

    await Promise.all(
      this.queueNames.map((queueName) => this.rabbitMq.start(queueName, this)),
    );
  }

  async handle(envelope: MessageEnvelope): Promise<MessageHandlingOutcome> {
    try {
      const outcome =
        envelope.type === 'aiflow.workflow.provisioning.requested.v1'
          ? await this.handleProvisioning(
              envelope as MessageEnvelope<ProvisioningData>,
            )
          : await this.handleSyntheticStage(envelope);
      this.telemetry.recordMessage(envelope.type, outcome);
      return outcome;
    } catch (error) {
      this.telemetry.recordMessage(envelope.type, 'ERROR');
      this.telemetry.captureException(error, 'message.handle');
      throw error;
    }
  }

  private async handleSyntheticStage(
    envelope: MessageEnvelope,
  ): Promise<MessageHandlingOutcome> {
    if (!this.syntheticStagesEnabled) {
      throw new Error('SYNTHETIC_STAGE_MODE_DISABLED');
    }
    return this.handleStage(envelope as MessageEnvelope<StageData>);
  }

  private async handleProvisioning(
    envelope: MessageEnvelope<ProvisioningData>,
  ): Promise<MessageHandlingOutcome> {
    const operation = await this.provisioning?.processActivation({
      consumerName: this.consumerName,
      expectedStateVersion: envelope.data.expectedStateVersion,
      leaseDurationMs: 30_000,
      leaseOwner: this.consumerName,
      messageId: envelope.messageId,
      messageType: envelope.type,
      operationId: envelope.data.provisioningOperationId,
      projectId: envelope.projectId,
      tenantId: envelope.tenantId,
    });
    return operation === undefined ? 'STALE' : 'CLAIMED';
  }

  private async handleStage(
    envelope: MessageEnvelope<StageData>,
  ): Promise<MessageHandlingOutcome> {
    const executions = this.executions;
    if (executions === undefined) {
      throw new Error('WORKER_NOT_READY');
    }
    const claimed = await executions.claimStage({
      consumerName: this.consumerName,
      expectedStateVersion: envelope.data.expectedStateVersion,
      executionId: envelope.data.executionId,
      leaseDurationMs: 30_000,
      leaseOwner: this.consumerName,
      messageId: envelope.messageId,
      messageType: envelope.type,
      projectId: envelope.projectId,
      stage: envelope.data.stage,
      tenantId: envelope.tenantId,
    });
    if (claimed === undefined) {
      return 'STALE';
    }
    await executions.completeStage({
      causationId: envelope.messageId,
      executionId: claimed.execution.executionId,
      expectedStateVersion: claimed.execution.stateVersion,
      leaseOwner: this.consumerName,
      stage: envelope.data.stage,
      tenantId: envelope.tenantId,
    });
    return 'CLAIMED';
  }
}
