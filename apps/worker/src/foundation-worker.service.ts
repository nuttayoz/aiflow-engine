import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import {
  BusinessCentralDeliveryProcessor,
  FakeBusinessCentralDestination,
  isPurchaseInvoiceDraftInput,
  microsoftBusinessCentralConnector,
} from '@aiflow/connector-microsoft-business-central';
import { directUploadConnector } from '@aiflow/connector-direct-upload';
import {
  AesGcmSharePointCursorProtector,
  FAKE_SHAREPOINT_ANY_CONNECTION_ID,
  FakeSharePointGraphAdapter,
  microsoftSharePointConnector,
  SharePointManagedEntryProvisioner,
} from '@aiflow/connector-microsoft-sharepoint';
import { phase1SyntheticConnector } from '@aiflow/connector-phase1-synthetic';
import { ConnectorRegistry } from '@aiflow/connector-sdk';
import {
  DatabaseService,
  PostgresExecutionRepository,
  PostgresPipelineRepository,
  PostgresSharePointProvisioningRepository,
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
import {
  ExtractionProcessor,
  FakeExtractionProvider,
  InMemoryExtractionProfileCatalog,
  PHASE2_INVOICE_PROFILE,
} from '@aiflow/extraction';
import { MappingProcessor } from '@aiflow/mappings';
import { WorkflowProvisioningService } from '@aiflow/workflows';
import { RuntimeTelemetry } from '@aiflow/observability';
import { S3ObjectStorage } from '@aiflow/storage';
import type { S3RuntimeConfig } from '@aiflow/config';
import type { SharePointRuntimeConfig } from '@aiflow/config';

import {
  SYNTHETIC_STAGES_ENABLED,
  WORKER_QUEUE_NAMES,
  WORKER_S3_CONFIG,
  WORKER_SHAREPOINT_CONFIG,
} from './worker.tokens';

const MESSAGE_TYPES = [
  'aiflow.workflow.provisioning.requested.v1',
  'aiflow.execution.stage.extract.requested.v1',
  'aiflow.execution.stage.map.requested.v1',
  'aiflow.execution.stage.reconcile.requested.v1',
  'aiflow.execution.stage.deliver.connector.microsoft-business-central.requested.v1',
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
  implements MessageHandler, OnApplicationBootstrap, OnApplicationShutdown
{
  readonly messageTypes = MESSAGE_TYPES;
  private readonly consumerName = `phase1-worker:${randomUUID()}`;
  private executions?: PostgresExecutionRepository;
  private extraction?: ExtractionProcessor;
  private mapping?: MappingProcessor;
  private pipeline?: PostgresPipelineRepository;
  private provisioning?: WorkflowProvisioningService;
  private delivery?: BusinessCentralDeliveryProcessor;
  private storage?: S3ObjectStorage;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RABBIT_MQ_CLIENT) private readonly rabbitMq: RabbitMqClient,
    @Inject(WORKER_QUEUE_NAMES) private readonly queueNames: readonly string[],
    @Inject(SYNTHETIC_STAGES_ENABLED)
    private readonly syntheticStagesEnabled: boolean,
    @Inject(WORKER_S3_CONFIG) private readonly s3Config: S3RuntimeConfig,
    @Inject(WORKER_SHAREPOINT_CONFIG)
    private readonly sharePointConfig: SharePointRuntimeConfig,
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
    this.pipeline = new PostgresPipelineRepository(
      this.database.dataSource,
      schema,
    );
    this.storage = new S3ObjectStorage(this.s3Config);
    const profiles = new InMemoryExtractionProfileCatalog([
      PHASE2_INVOICE_PROFILE,
    ]);
    const extractionProvider = new FakeExtractionProvider();
    const businessCentral = new FakeBusinessCentralDestination();
    this.extraction = new ExtractionProcessor(
      this.pipeline,
      this.executions,
      this.storage,
      extractionProvider,
      profiles,
    );
    this.mapping = new MappingProcessor(
      this.pipeline,
      this.executions,
      this.storage,
      {
        validate: ({ actionId, connectorId, payload }) => ({
          actionVersion: 1,
          valid:
            connectorId === 'microsoft-business-central' &&
            actionId === 'create-purchase-invoice-draft' &&
            isPurchaseInvoiceDraftInput(payload),
        }),
      },
    );
    this.delivery = new BusinessCentralDeliveryProcessor(
      this.pipeline,
      this.storage,
      businessCentral,
    );
    this.provisioning = new WorkflowProvisioningService(
      new PostgresWorkflowProvisioningRepository(
        this.database.dataSource,
        schema,
      ),
      workflows,
      new ConnectorRegistry([
        directUploadConnector,
        microsoftBusinessCentralConnector,
        microsoftSharePointConnector,
        phase1SyntheticConnector,
      ]),
      this.syntheticStagesEnabled
        ? [this.createFakeSharePointProvisioner(schema)]
        : [],
    );

    await Promise.all(
      this.queueNames.map((queueName) => this.rabbitMq.start(queueName, this)),
    );
  }

  onApplicationShutdown(): void {
    this.storage?.close();
  }

  async handle(envelope: MessageEnvelope): Promise<MessageHandlingOutcome> {
    try {
      const outcome =
        envelope.type === 'aiflow.workflow.provisioning.requested.v1'
          ? await this.handleProvisioning(
              envelope as MessageEnvelope<ProvisioningData>,
            )
          : envelope.type === 'aiflow.execution.stage.reconcile.requested.v1'
            ? await this.handleReconciliation(
                envelope as MessageEnvelope<StageData>,
              )
            : await this.handleStage(envelope as MessageEnvelope<StageData>);
      this.telemetry.recordMessage(envelope.type, outcome);
      return outcome;
    } catch (error) {
      this.telemetry.recordMessage(envelope.type, 'ERROR');
      this.telemetry.captureException(error, 'message.handle');
      throw error;
    }
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
    const pipeline = this.pipeline;
    if (executions === undefined || pipeline === undefined) {
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
    const connectorId = await pipeline.findDestinationConnectorId(
      envelope.tenantId,
      envelope.data.executionId,
    );
    if (connectorId === 'phase1-synthetic') {
      if (!this.syntheticStagesEnabled) {
        throw new Error('SYNTHETIC_STAGE_MODE_DISABLED');
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
    if (!this.syntheticStagesEnabled) {
      throw new Error('PHASE2_EXTERNAL_ADAPTER_NOT_CONFIGURED');
    }
    if (envelope.data.stage === 'EXTRACT') {
      await this.requireExtraction().process(claimed, envelope.messageId);
    } else if (envelope.data.stage === 'MAP') {
      await this.requireMapping().process(claimed, envelope.messageId);
    } else if (envelope.data.stage === 'DELIVER') {
      await this.requireDelivery().process(claimed, envelope.messageId);
    } else {
      throw new Error('WORKER_STAGE_UNSUPPORTED');
    }
    return 'CLAIMED';
  }

  private async handleReconciliation(
    envelope: MessageEnvelope<StageData>,
  ): Promise<MessageHandlingOutcome> {
    if (!this.syntheticStagesEnabled) {
      throw new Error('PHASE2_EXTERNAL_ADAPTER_NOT_CONFIGURED');
    }
    await this.requireDelivery().reconcile({
      causationId: envelope.messageId,
      executionId: envelope.data.executionId,
      expectedStateVersion: envelope.data.expectedStateVersion,
      tenantId: envelope.tenantId,
    });
    return 'CLAIMED';
  }

  private requireDelivery(): BusinessCentralDeliveryProcessor {
    if (this.delivery === undefined) {
      throw new Error('WORKER_NOT_READY');
    }
    return this.delivery;
  }

  private requireExtraction(): ExtractionProcessor {
    if (this.extraction === undefined) {
      throw new Error('WORKER_NOT_READY');
    }
    return this.extraction;
  }

  private requireMapping(): MappingProcessor {
    if (this.mapping === undefined) {
      throw new Error('WORKER_NOT_READY');
    }
    return this.mapping;
  }

  private createFakeSharePointProvisioner(
    schema: string,
  ): SharePointManagedEntryProvisioner {
    const key = {
      keyVersion: this.sharePointConfig.currentKeyVersion,
      rootKey: this.sharePointConfig.rootKey,
    };
    const target = {
      connectionId: FAKE_SHAREPOINT_ANY_CONNECTION_ID,
      driveId: 'demo-sharepoint-drive',
      externalTenantId: 'demo-microsoft-tenant',
      folderId: 'demo-sharepoint-inbound',
      rootItemId: 'demo-sharepoint-root',
      siteId: 'demo-sharepoint-site',
    };
    const graph = new FakeSharePointGraphAdapter([target]);
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      finalCursor: 'fake-baseline-delta-cursor',
      items: [
        {
          eTag: 'fake-folder-etag',
          id: target.folderId,
          kind: 'FOLDER',
          name: 'Inbound',
          parentId: target.rootItemId,
        },
      ],
    });
    const repository = new PostgresSharePointProvisioningRepository(
      this.database.dataSource,
      schema,
      new AesGcmSharePointCursorProtector(
        [key],
        this.sharePointConfig.currentKeyVersion,
      ),
    );
    return new SharePointManagedEntryProvisioner(
      repository,
      graph,
      [key],
      this.sharePointConfig.currentKeyVersion,
      this.sharePointConfig.callbackUrl,
    );
  }
}
