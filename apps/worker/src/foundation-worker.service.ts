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
  SharePointIngestionProcessor,
  SharePointManagedEntryProvisioner,
  SharePointSyncProcessor,
} from '@aiflow/connector-microsoft-sharepoint';
import { phase1SyntheticConnector } from '@aiflow/connector-phase1-synthetic';
import { ConnectorRegistry } from '@aiflow/connector-sdk';
import {
  DatabaseService,
  PostgresExecutionRepository,
  PostgresPipelineRepository,
  PostgresSharePointIngestionRepository,
  PostgresSharePointProvisioningRepository,
  PostgresSharePointSyncRepository,
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
  'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
  'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
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

interface SharePointSyncData extends Readonly<Record<string, unknown>> {
  readonly expectedNotificationGeneration: number;
  readonly expectedStateVersion: number;
  readonly watchId: string;
}

interface SharePointIngestionData extends Readonly<Record<string, unknown>> {
  readonly connectorId: 'microsoft-sharepoint';
  readonly expectedStateVersion: number;
  readonly ingestionId: string;
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
  private sharePointIngestion?: SharePointIngestionProcessor;
  private sharePointSync?: SharePointSyncProcessor;
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
    const sharePointRuntime = this.syntheticStagesEnabled
      ? this.createFakeSharePointRuntime(schema, this.storage)
      : undefined;
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
      sharePointRuntime === undefined ? [] : [sharePointRuntime.provisioner],
    );
    this.sharePointIngestion = sharePointRuntime?.ingestion;
    this.sharePointSync = sharePointRuntime?.sync;

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
        envelope.type ===
        'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1'
          ? await this.handleSharePointSync(
              envelope as MessageEnvelope<SharePointSyncData>,
            )
          : envelope.type ===
              'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1'
            ? await this.handleSharePointIngestion(
                envelope as MessageEnvelope<SharePointIngestionData>,
              )
            : envelope.type === 'aiflow.workflow.provisioning.requested.v1'
              ? await this.handleProvisioning(
                  envelope as MessageEnvelope<ProvisioningData>,
                )
              : envelope.type ===
                  'aiflow.execution.stage.reconcile.requested.v1'
                ? await this.handleReconciliation(
                    envelope as MessageEnvelope<StageData>,
                  )
                : await this.handleStage(
                    envelope as MessageEnvelope<StageData>,
                  );
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

  private async handleSharePointSync(
    envelope: MessageEnvelope<SharePointSyncData>,
  ): Promise<MessageHandlingOutcome> {
    if (this.sharePointSync === undefined) {
      throw new Error('SHAREPOINT_GRAPH_ADAPTER_NOT_CONFIGURED');
    }
    const outcome = await this.sharePointSync.process({
      consumerName: this.consumerName,
      leaseDurationMs: 30_000,
      leaseOwner: this.consumerName,
      messageId: envelope.messageId,
      messageType: envelope.type,
      projectId: envelope.projectId,
      tenantId: envelope.tenantId,
      watchId: envelope.data.watchId,
    });
    return outcome === 'STALE' ? 'STALE' : 'CLAIMED';
  }

  private async handleSharePointIngestion(
    envelope: MessageEnvelope<SharePointIngestionData>,
  ): Promise<MessageHandlingOutcome> {
    if (this.sharePointIngestion === undefined) {
      throw new Error('SHAREPOINT_GRAPH_ADAPTER_NOT_CONFIGURED');
    }
    const outcome = await this.sharePointIngestion.process({
      consumerName: this.consumerName,
      expectedStateVersion: envelope.data.expectedStateVersion,
      ingestionId: envelope.data.ingestionId,
      leaseDurationMs: 30_000,
      leaseOwner: this.consumerName,
      messageId: envelope.messageId,
      messageType: envelope.type,
      projectId: envelope.projectId,
      tenantId: envelope.tenantId,
    });
    return outcome === 'STALE' ? 'STALE' : 'CLAIMED';
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

  private createFakeSharePointRuntime(
    schema: string,
    storage: S3ObjectStorage,
  ): {
    readonly ingestion: SharePointIngestionProcessor;
    readonly provisioner: SharePointManagedEntryProvisioner;
    readonly sync: SharePointSyncProcessor;
  } {
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
    const cursorProtector = new AesGcmSharePointCursorProtector(
      [key],
      this.sharePointConfig.currentKeyVersion,
    );
    const repository = new PostgresSharePointProvisioningRepository(
      this.database.dataSource,
      schema,
      cursorProtector,
    );
    return {
      ingestion: new SharePointIngestionProcessor(
        new PostgresSharePointIngestionRepository(
          this.database.dataSource,
          schema,
        ),
        graph,
        storage,
      ),
      provisioner: new SharePointManagedEntryProvisioner(
        repository,
        graph,
        [key],
        this.sharePointConfig.currentKeyVersion,
        this.sharePointConfig.callbackUrl,
      ),
      sync: new SharePointSyncProcessor(
        new PostgresSharePointSyncRepository(
          this.database.dataSource,
          schema,
          cursorProtector,
        ),
        graph,
      ),
    };
  }
}
