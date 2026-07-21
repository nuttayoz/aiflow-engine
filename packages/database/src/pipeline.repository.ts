import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import type { ActorIdentity } from '@aiflow/core';
import { createMessageEnvelope } from '@aiflow/messaging';
import {
  buildStorageObjectKey,
  type StorageChecksum,
  type StoredObjectMetadata,
} from '@aiflow/storage';
import type { WorkflowDefinitionV1 } from '@aiflow/workflows';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

export interface PipelineStorageReference {
  readonly checksum: StorageChecksum;
  readonly contentType: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly storageObjectId: string;
  readonly versionId: string;
}

export interface PipelineWorkContext {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly contentSha256: string;
  readonly correlationId: string;
  readonly documentId: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly profileVersionId: string;
  readonly rootExecutionId: string;
  readonly source: PipelineStorageReference;
  readonly stateVersion: number;
  readonly tenantId: string;
  readonly workflowDefinition: WorkflowDefinitionV1;
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export interface ProcessingArtifactRecord {
  readonly payloadSha256?: string;
  readonly schemaVersion: number;
  readonly stage: 'EXTRACT' | 'MAP';
  readonly status: 'AVAILABLE' | 'RESERVED';
  readonly storageObjectId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly metadata?: StoredObjectMetadata;
}

export interface ExtractionRequestRecord {
  readonly adapterId: string;
  readonly callbackCorrelationId: string;
  readonly deadlineAt: Date;
  readonly executionId: string;
  readonly id: string;
  readonly nextCheckAt: Date;
  readonly profileId: string;
  readonly profileVersionId: string;
  readonly projectId: string;
  readonly providerOperationRef?: string;
  readonly resultSchemaVersion: number;
  readonly resultStorageObjectId: string;
  readonly stateVersion: number;
  readonly status:
    'ACCEPTED' | 'COMPLETED' | 'FAILED' | 'RESULT_AVAILABLE' | 'SUBMITTING';
  readonly tenantId: string;
}

export interface DeliveryOperationRecord {
  readonly actionId: string;
  readonly actionVersion: number;
  readonly companyResourceId: string;
  readonly connectorId: string;
  readonly currentExecutionId: string;
  readonly effectKey: string;
  readonly id: string;
  readonly input: PipelineStorageReference;
  readonly inputSchemaVersion: number;
  readonly payloadSha256: string;
  readonly projectId: string;
  readonly reconciliationDeadlineAt: Date;
  readonly rootExecutionId: string;
  readonly stateVersion: number;
  readonly status: 'APPLIED' | 'FAILED' | 'READY' | 'SUBMITTING' | 'UNKNOWN';
  readonly tenantId: string;
}

interface WorkRow {
  actor_id: string;
  actor_type: ActorIdentity['type'];
  causation_id: string;
  checksum_algorithm: 'SHA256';
  checksum_type: StorageChecksum['type'];
  checksum_value: string;
  content_sha256: string | null;
  content_type: string;
  correlation_id: string;
  document_id: string;
  execution_id: string;
  object_key: string;
  project_id: string;
  profile_version_id: string;
  root_execution_id: string;
  size_bytes: number | string;
  source_storage_object_id: string;
  state_version: number | string;
  tenant_id: string;
  version_id: string;
  workflow_definition: WorkflowDefinitionV1 | string;
  workflow_id: string;
  workflow_version_id: string;
}

interface ArtifactRow {
  checksum_algorithm: 'SHA256' | null;
  checksum_type: StorageChecksum['type'] | null;
  checksum_value: string | null;
  content_type: string | null;
  encryption_key_ref: string | null;
  encryption_mode: string | null;
  execution_id: string;
  object_key: string;
  payload_sha256: string | null;
  schema_version: number | string;
  size_bytes: number | string | null;
  stage: 'EXTRACT' | 'MAP';
  status: 'AVAILABLE' | 'RESERVED';
  storage_object_id: string;
  tenant_id: string;
  version_id: string | null;
}

interface ExtractionRow {
  adapter_id: string;
  callback_correlation_id: string;
  deadline_at: Date | string;
  execution_id: string;
  id: string;
  next_check_at: Date | string;
  profile_id: string;
  profile_version_id: string;
  project_id: string;
  provider_operation_ref: string | null;
  result_schema_version: number | string;
  result_storage_object_id: string;
  state_version: number | string;
  status: ExtractionRequestRecord['status'];
  tenant_id: string;
}

interface DeliveryRow {
  action_id: string;
  action_version: number | string;
  checksum_algorithm: 'SHA256';
  checksum_type: StorageChecksum['type'];
  checksum_value: string;
  company_resource_id: string;
  connector_id: string;
  content_type: string;
  current_execution_id: string;
  effect_key: string;
  id: string;
  input_schema_version: number | string;
  input_storage_object_id: string;
  object_key: string;
  payload_sha256: string;
  project_id: string;
  reconciliation_deadline_at: Date | string;
  root_execution_id: string;
  size_bytes: number | string;
  state_version: number | string;
  status: DeliveryOperationRecord['status'];
  tenant_id: string;
  version_id: string;
}

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

const parseDefinition = (
  value: WorkflowDefinitionV1 | string,
): WorkflowDefinitionV1 =>
  typeof value === 'string'
    ? (JSON.parse(value) as WorkflowDefinitionV1)
    : value;

const mapWork = (row: WorkRow): PipelineWorkContext => {
  if (row.content_sha256 === null) {
    throw new Error('DOCUMENT_CONTENT_CHECKSUM_MISSING');
  }
  return {
    actor: { id: row.actor_id, type: row.actor_type },
    causationId: row.causation_id,
    contentSha256: row.content_sha256,
    correlationId: row.correlation_id,
    documentId: row.document_id,
    executionId: row.execution_id,
    projectId: row.project_id,
    profileVersionId: row.profile_version_id,
    rootExecutionId: row.root_execution_id,
    source: {
      checksum: {
        algorithm: row.checksum_algorithm,
        type: row.checksum_type,
        value: row.checksum_value,
      },
      contentType: row.content_type,
      key: row.object_key,
      sizeBytes: Number(row.size_bytes),
      storageObjectId: row.source_storage_object_id,
      versionId: row.version_id,
    },
    stateVersion: Number(row.state_version),
    tenantId: row.tenant_id,
    workflowDefinition: parseDefinition(row.workflow_definition),
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
  };
};

const mapArtifact = (row: ArtifactRow): ProcessingArtifactRecord => ({
  executionId: row.execution_id,
  ...(row.payload_sha256 === null ? {} : { payloadSha256: row.payload_sha256 }),
  schemaVersion: Number(row.schema_version),
  stage: row.stage,
  status: row.status,
  storageObjectId: row.storage_object_id,
  tenantId: row.tenant_id,
  ...(row.version_id === null ||
  row.size_bytes === null ||
  row.content_type === null ||
  row.checksum_algorithm === null ||
  row.checksum_type === null ||
  row.checksum_value === null ||
  row.encryption_mode === null
    ? {}
    : {
        metadata: {
          checksum: {
            algorithm: row.checksum_algorithm,
            type: row.checksum_type,
            value: row.checksum_value,
          },
          contentType: row.content_type,
          ...(row.encryption_key_ref === null
            ? {}
            : { encryptionKeyRef: row.encryption_key_ref }),
          encryptionMode: row.encryption_mode,
          key: row.object_key,
          sizeBytes: Number(row.size_bytes),
          versionId: row.version_id,
        },
      }),
});

const mapExtraction = (row: ExtractionRow): ExtractionRequestRecord => ({
  adapterId: row.adapter_id,
  callbackCorrelationId: row.callback_correlation_id,
  deadlineAt: new Date(row.deadline_at),
  executionId: row.execution_id,
  id: row.id,
  nextCheckAt: new Date(row.next_check_at),
  profileId: row.profile_id,
  profileVersionId: row.profile_version_id,
  projectId: row.project_id,
  ...(row.provider_operation_ref === null
    ? {}
    : { providerOperationRef: row.provider_operation_ref }),
  resultSchemaVersion: Number(row.result_schema_version),
  resultStorageObjectId: row.result_storage_object_id,
  stateVersion: Number(row.state_version),
  status: row.status,
  tenantId: row.tenant_id,
});

const mapDelivery = (row: DeliveryRow): DeliveryOperationRecord => ({
  actionId: row.action_id,
  actionVersion: Number(row.action_version),
  companyResourceId: row.company_resource_id,
  connectorId: row.connector_id,
  currentExecutionId: row.current_execution_id,
  effectKey: row.effect_key,
  id: row.id,
  input: {
    checksum: {
      algorithm: row.checksum_algorithm,
      type: row.checksum_type,
      value: row.checksum_value,
    },
    contentType: row.content_type,
    key: row.object_key,
    sizeBytes: Number(row.size_bytes),
    storageObjectId: row.input_storage_object_id,
    versionId: row.version_id,
  },
  inputSchemaVersion: Number(row.input_schema_version),
  payloadSha256: row.payload_sha256,
  projectId: row.project_id,
  reconciliationDeadlineAt: new Date(row.reconciliation_deadline_at),
  rootExecutionId: row.root_execution_id,
  stateVersion: Number(row.state_version),
  status: row.status,
  tenantId: row.tenant_id,
});

const artifactColumns = `
  artifact.tenant_id,
  artifact.execution_id,
  artifact.stage,
  artifact.storage_object_id,
  artifact.schema_version,
  artifact.payload_sha256,
  artifact.status,
  storage.object_key,
  storage.version_id,
  storage.size_bytes,
  storage.content_type,
  storage.checksum_algorithm,
  storage.checksum_type,
  storage.checksum_value,
  storage.encryption_mode,
  storage.encryption_key_ref
`;

const extractionColumns = `
  id,
  tenant_id,
  project_id,
  execution_id,
  profile_id,
  profile_version_id,
  adapter_id,
  callback_correlation_id,
  provider_operation_ref,
  result_storage_object_id,
  result_schema_version,
  status,
  state_version,
  next_check_at,
  deadline_at
`;

const deliveryColumns = `
  operation.id,
  operation.tenant_id,
  operation.project_id,
  operation.root_execution_id,
  operation.current_execution_id,
  operation.connector_id,
  operation.action_id,
  operation.action_version,
  operation.company_resource_id,
  operation.effect_key,
  operation.payload_sha256,
  operation.input_storage_object_id,
  operation.input_schema_version,
  operation.status,
  operation.state_version,
  operation.reconciliation_deadline_at,
  storage.object_key,
  storage.version_id,
  storage.size_bytes,
  storage.content_type,
  storage.checksum_algorithm,
  storage.checksum_type,
  storage.checksum_value
`;

export class PostgresPipelineRepository {
  private readonly artifacts: string;
  private readonly attempts: string;
  private readonly auditEvents: string;
  private readonly callbackEvents: string;
  private readonly deliveryOperations: string;
  private readonly documents: string;
  private readonly executions: string;
  private readonly extractionRequests: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly profileReferences: string;
  private readonly stages: string;
  private readonly storageObjects: string;
  private readonly versions: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.artifacts = table(schema, 'processing_artifacts');
    this.attempts = table(schema, 'stage_attempts');
    this.auditEvents = table(schema, 'audit_events');
    this.callbackEvents = table(schema, 'extraction_callback_events');
    this.deliveryOperations = table(schema, 'delivery_operations');
    this.documents = table(schema, 'documents');
    this.executions = table(schema, 'executions');
    this.extractionRequests = table(schema, 'extraction_requests');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.profileReferences = table(schema, 'workflow_version_profile_refs');
    this.stages = table(schema, 'execution_stages');
    this.storageObjects = table(schema, 'storage_objects');
    this.versions = table(schema, 'workflow_versions');
  }

  async loadWorkContext(
    tenantId: string,
    executionId: string,
  ): Promise<PipelineWorkContext | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          execution.id AS execution_id,
          execution.tenant_id,
          execution.project_id,
          execution.workflow_id,
          execution.workflow_version_id,
          execution.document_id,
          execution.root_execution_id,
          execution.state_version,
          execution.actor_type,
          execution.actor_id,
          execution.correlation_id,
          execution.causation_id,
          version.definition AS workflow_definition,
          profile.profile_version_id,
          document.source_storage_object_id,
          document.content_sha256,
          storage.object_key,
          storage.version_id,
          storage.size_bytes,
          storage.content_type,
          storage.checksum_algorithm,
          storage.checksum_type,
          storage.checksum_value
        FROM ${this.executions} AS execution
        JOIN ${this.versions} AS version
          ON version.tenant_id = execution.tenant_id
         AND version.id = execution.workflow_version_id
        JOIN ${this.documents} AS document
          ON document.tenant_id = execution.tenant_id
         AND document.id = execution.document_id
        JOIN ${this.profileReferences} AS profile
          ON profile.tenant_id = execution.tenant_id
         AND profile.workflow_version_id = execution.workflow_version_id
        JOIN ${this.storageObjects} AS storage
          ON storage.tenant_id = document.tenant_id
         AND storage.id = document.source_storage_object_id
         AND storage.status = 'AVAILABLE'
        WHERE execution.tenant_id = $1 AND execution.id = $2
      `,
      [tenantId, executionId],
    )) as WorkRow[];
    return rows[0] === undefined ? undefined : mapWork(rows[0]);
  }

  async findDestinationConnectorId(
    tenantId: string,
    executionId: string,
  ): Promise<string | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT version.definition -> 'destination' ->> 'connectorId' AS connector_id
        FROM ${this.executions} AS execution
        JOIN ${this.versions} AS version
          ON version.tenant_id = execution.tenant_id
         AND version.id = execution.workflow_version_id
        WHERE execution.tenant_id = $1 AND execution.id = $2
      `,
      [tenantId, executionId],
    )) as { connector_id: string | null }[];
    return rows[0]?.connector_id ?? undefined;
  }

  async findArtifact(
    tenantId: string,
    executionId: string,
    stage: 'EXTRACT' | 'MAP',
  ): Promise<ProcessingArtifactRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT ${artifactColumns}
        FROM ${this.artifacts} AS artifact
        JOIN ${this.storageObjects} AS storage
          ON storage.tenant_id = artifact.tenant_id
         AND storage.id = artifact.storage_object_id
        WHERE artifact.tenant_id = $1
          AND artifact.execution_id = $2
          AND artifact.stage = $3
      `,
      [tenantId, executionId, stage],
    )) as ArtifactRow[];
    return rows[0] === undefined ? undefined : mapArtifact(rows[0]);
  }

  async prepareExtraction(input: {
    readonly adapterId: string;
    readonly callbackCorrelationId: string;
    readonly deadlineAt: Date;
    readonly executionId: string;
    readonly extractionRequestId: string;
    readonly leaseOwner: string;
    readonly nextCheckAt: Date;
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly projectId: string;
    readonly resultStorageObjectId: string;
    readonly retentionUntil: Date;
    readonly stageAttemptId: string;
    readonly tenantId: string;
  }): Promise<{
    readonly artifact: ProcessingArtifactRecord;
    readonly request: ExtractionRequestRecord;
  }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = (await manager.query(
        `SELECT id FROM ${this.extractionRequests} WHERE tenant_id = $1 AND execution_id = $2 FOR UPDATE`,
        [input.tenantId, input.executionId],
      )) as { id: string }[];
      if (existing.length > 0) {
        return;
      }
      await this.requireRunningAttempt(manager, {
        executionId: input.executionId,
        leaseOwner: input.leaseOwner,
        stage: 'EXTRACT',
        stageAttemptId: input.stageAttemptId,
        tenantId: input.tenantId,
      });
      await this.insertArtifactReservation(manager, {
        executionId: input.executionId,
        projectId: input.projectId,
        retentionUntil: input.retentionUntil,
        schemaVersion: 1,
        stage: 'EXTRACT',
        storageObjectId: input.resultStorageObjectId,
        tenantId: input.tenantId,
      });
      await manager.query(
        `
          INSERT INTO ${this.extractionRequests} (
            id,
            tenant_id,
            project_id,
            execution_id,
            stage_attempt_id,
            profile_id,
            profile_version_id,
            adapter_id,
            callback_correlation_id,
            result_storage_object_id,
            result_schema_version,
            next_check_at,
            deadline_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12)
        `,
        [
          input.extractionRequestId,
          input.tenantId,
          input.projectId,
          input.executionId,
          input.stageAttemptId,
          input.profileId,
          input.profileVersionId,
          input.adapterId,
          input.callbackCorrelationId,
          input.resultStorageObjectId,
          input.nextCheckAt,
          input.deadlineAt,
        ],
      );
    });
    const request = await this.findExtraction(
      input.tenantId,
      input.executionId,
    );
    const artifact = await this.findArtifact(
      input.tenantId,
      input.executionId,
      'EXTRACT',
    );
    if (request === undefined || artifact === undefined) {
      throw new Error('EXTRACTION_PREPARE_INCONSISTENT');
    }
    return { artifact, request };
  }

  async findExtraction(
    tenantId: string,
    executionId: string,
  ): Promise<ExtractionRequestRecord | undefined> {
    const rows = (await this.dataSource.query(
      `SELECT ${extractionColumns} FROM ${this.extractionRequests} WHERE tenant_id = $1 AND execution_id = $2`,
      [tenantId, executionId],
    )) as ExtractionRow[];
    return rows[0] === undefined ? undefined : mapExtraction(rows[0]);
  }

  async recordExtractionAccepted(input: {
    readonly nextCheckAt: Date;
    readonly providerOperationRef: string;
    readonly requestId: string;
    readonly tenantId: string;
  }): Promise<ExtractionRequestRecord> {
    const rows = mutationRows<ExtractionRow>(
      await this.dataSource.query(
        `
          UPDATE ${this.extractionRequests}
          SET provider_operation_ref = COALESCE(provider_operation_ref, $3),
              status = CASE WHEN status = 'SUBMITTING' THEN 'ACCEPTED' ELSE status END,
              state_version = state_version + 1,
              next_check_at = $4,
              submitted_at = COALESCE(submitted_at, clock_timestamp()),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = $2
            AND status IN ('SUBMITTING', 'ACCEPTED', 'RESULT_AVAILABLE')
            AND (provider_operation_ref IS NULL OR provider_operation_ref = $3)
          RETURNING ${extractionColumns}
        `,
        [
          input.tenantId,
          input.requestId,
          input.providerOperationRef,
          input.nextCheckAt,
        ],
      ),
    );
    if (rows[0] === undefined) {
      throw new Error('EXTRACTION_REQUEST_TRANSITION_CONFLICT');
    }
    return mapExtraction(rows[0]);
  }

  async markExtractionResultAvailable(
    tenantId: string,
    requestId: string,
  ): Promise<void> {
    const rows = mutationRows<{ id: string }>(
      await this.dataSource.query(
        `
          UPDATE ${this.extractionRequests}
          SET status = 'RESULT_AVAILABLE',
              state_version = state_version + 1,
              next_check_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = $2
            AND status IN ('SUBMITTING', 'ACCEPTED', 'RESULT_AVAILABLE')
          RETURNING id
        `,
        [tenantId, requestId],
      ),
    );
    if (rows.length !== 1) {
      throw new Error('EXTRACTION_REQUEST_TRANSITION_CONFLICT');
    }
  }

  async prepareMappingArtifact(input: {
    readonly executionId: string;
    readonly leaseOwner: string;
    readonly projectId: string;
    readonly retentionUntil: Date;
    readonly stageAttemptId: string;
    readonly storageObjectId: string;
    readonly tenantId: string;
  }): Promise<ProcessingArtifactRecord> {
    await this.dataSource.transaction(async (manager) => {
      const existing = (await manager.query(
        `SELECT storage_object_id FROM ${this.artifacts} WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'MAP' FOR UPDATE`,
        [input.tenantId, input.executionId],
      )) as { storage_object_id: string }[];
      if (existing.length > 0) {
        return;
      }
      await this.requireRunningAttempt(manager, {
        executionId: input.executionId,
        leaseOwner: input.leaseOwner,
        stage: 'MAP',
        stageAttemptId: input.stageAttemptId,
        tenantId: input.tenantId,
      });
      await this.insertArtifactReservation(manager, {
        executionId: input.executionId,
        projectId: input.projectId,
        retentionUntil: input.retentionUntil,
        schemaVersion: 1,
        stage: 'MAP',
        storageObjectId: input.storageObjectId,
        tenantId: input.tenantId,
      });
    });
    const artifact = await this.findArtifact(
      input.tenantId,
      input.executionId,
      'MAP',
    );
    if (artifact === undefined) {
      throw new Error('MAPPING_PREPARE_INCONSISTENT');
    }
    return artifact;
  }

  async completeExtraction(input: {
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly metadata: StoredObjectMetadata;
    readonly requestId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockRunningStage(manager, {
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        leaseOwner: input.leaseOwner,
        stage: 'EXTRACT',
        tenantId: input.tenantId,
      });
      const artifact = await this.makeArtifactAvailable(manager, {
        executionId: input.executionId,
        metadata: input.metadata,
        payloadSha256: undefined,
        stage: 'EXTRACT',
        tenantId: input.tenantId,
      });
      const requests = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.extractionRequests}
            SET status = 'COMPLETED',
                state_version = state_version + 1,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND execution_id = $3
              AND result_storage_object_id = $4
              AND status IN ('ACCEPTED', 'RESULT_AVAILABLE', 'SUBMITTING')
            RETURNING id
          `,
          [
            input.tenantId,
            input.requestId,
            input.executionId,
            artifact.storageObjectId,
          ],
        ),
      );
      if (requests.length !== 1) {
        throw new Error('EXTRACTION_REQUEST_TRANSITION_CONFLICT');
      }
      await manager.query(
        `
          UPDATE ${this.documents}
          SET content_sha256_verified_at = COALESCE(
            content_sha256_verified_at,
            clock_timestamp()
          )
          WHERE tenant_id = $1 AND id = $2
        `,
        [input.tenantId, current.documentId],
      );
      await this.finishArtifactStage(manager, {
        ...input,
        artifact,
        current,
        nextStage: 'MAP',
      });
    });
  }

  async completeMapping(input: {
    readonly actionId: string;
    readonly actionVersion: number;
    readonly causationId: string;
    readonly companyResourceId: string;
    readonly connectorId: string;
    readonly deliveryOperationId: string;
    readonly effectKey: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly metadata: StoredObjectMetadata;
    readonly payloadSha256: string;
    readonly reconciliationDeadlineAt: Date;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockRunningStage(manager, {
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        leaseOwner: input.leaseOwner,
        stage: 'MAP',
        tenantId: input.tenantId,
      });
      const artifact = await this.makeArtifactAvailable(manager, {
        executionId: input.executionId,
        metadata: input.metadata,
        payloadSha256: input.payloadSha256,
        stage: 'MAP',
        tenantId: input.tenantId,
      });
      if (
        input.connectorId !== current.destinationConnectorId ||
        input.actionId !== current.destinationActionId ||
        input.companyResourceId !== current.destinationCompanyResourceId
      ) {
        throw new Error('DELIVERY_TARGET_MISMATCH');
      }
      const deliveryRows = mutationRows<{ id: string; payload_sha256: string }>(
        await manager.query(
          `
            INSERT INTO ${this.deliveryOperations} (
              id,
              tenant_id,
              project_id,
              root_execution_id,
              current_execution_id,
              connector_id,
              action_id,
              action_version,
              company_resource_id,
              effect_key,
              payload_sha256,
              input_storage_object_id,
              input_schema_version,
              reconciliation_deadline_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13
            )
            ON CONFLICT (
              tenant_id, root_execution_id, connector_id, action_id, action_version
            ) DO UPDATE SET current_execution_id = EXCLUDED.current_execution_id
            WHERE ${this.deliveryOperations}.payload_sha256 = EXCLUDED.payload_sha256
              AND ${this.deliveryOperations}.input_storage_object_id = EXCLUDED.input_storage_object_id
            RETURNING id, payload_sha256
          `,
          [
            input.deliveryOperationId,
            input.tenantId,
            current.projectId,
            current.rootExecutionId,
            input.executionId,
            input.connectorId,
            input.actionId,
            input.actionVersion,
            input.companyResourceId,
            input.effectKey,
            input.payloadSha256,
            artifact.storageObjectId,
            input.reconciliationDeadlineAt,
          ],
        ),
      );
      if (deliveryRows.length !== 1) {
        throw new Error('DELIVERY_EFFECT_CONFLICT');
      }
      await this.finishArtifactStage(manager, {
        ...input,
        artifact,
        current,
        nextStage: 'DELIVER',
      });
    });
  }

  async findDelivery(
    tenantId: string,
    executionId: string,
  ): Promise<DeliveryOperationRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT ${deliveryColumns}
        FROM ${this.deliveryOperations} AS operation
        JOIN ${this.executions} AS execution
          ON execution.tenant_id = operation.tenant_id
         AND execution.root_execution_id = operation.root_execution_id
        JOIN ${this.storageObjects} AS storage
          ON storage.tenant_id = operation.tenant_id
         AND storage.id = operation.input_storage_object_id
         AND storage.status = 'AVAILABLE'
        WHERE operation.tenant_id = $1 AND execution.id = $2
      `,
      [tenantId, executionId],
    )) as DeliveryRow[];
    return rows[0] === undefined ? undefined : mapDelivery(rows[0]);
  }

  async startDelivery(input: {
    readonly executionId: string;
    readonly expectedOperationStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<DeliveryOperationRecord> {
    const rows = mutationRows<{ id: string }>(
      await this.dataSource.transaction(async (manager) => {
        await this.requireRunningStage(manager, {
          executionId: input.executionId,
          leaseOwner: input.leaseOwner,
          stage: 'DELIVER',
          tenantId: input.tenantId,
        });
        return manager.query(
          `
            UPDATE ${this.deliveryOperations}
            SET status = 'SUBMITTING',
                state_version = state_version + 1,
                current_execution_id = $3,
                next_check_at = clock_timestamp() + interval '5 seconds',
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND state_version = $4
              AND status = 'READY'
            RETURNING id
          `,
          [
            input.tenantId,
            input.operationId,
            input.executionId,
            input.expectedOperationStateVersion,
          ],
        );
      }),
    );
    if (rows.length !== 1) {
      throw new Error('DELIVERY_OPERATION_TRANSITION_CONFLICT');
    }
    const operation = await this.findDelivery(
      input.tenantId,
      input.executionId,
    );
    if (operation === undefined) {
      throw new Error('DELIVERY_OPERATION_NOT_FOUND');
    }
    return operation;
  }

  async completeDelivery(input: {
    readonly appliedAt: Date;
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly externalResourceId: string;
    readonly externalResourceNumber: string;
    readonly externalResourceType: string;
    readonly externalVersion: string;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockRunningStage(manager, {
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        leaseOwner: input.leaseOwner,
        stage: 'DELIVER',
        tenantId: input.tenantId,
      });
      const operations = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.deliveryOperations}
            SET status = 'APPLIED',
                state_version = state_version + 1,
                external_resource_type = $4,
                external_resource_id = $5,
                external_resource_number = $6,
                external_version = $7,
                applied_at = $8,
                next_check_at = NULL,
                failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND current_execution_id = $3
              AND status IN ('SUBMITTING', 'UNKNOWN')
            RETURNING id
          `,
          [
            input.tenantId,
            input.operationId,
            input.executionId,
            input.externalResourceType,
            input.externalResourceId,
            input.externalResourceNumber,
            input.externalVersion,
            input.appliedAt,
          ],
        ),
      );
      if (operations.length !== 1) {
        throw new Error('DELIVERY_OPERATION_TRANSITION_CONFLICT');
      }
      await this.finishTerminalDelivery(manager, input, current);
    });
  }

  async markDeliveryUnknown(input: {
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockRunningStage(manager, {
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        leaseOwner: input.leaseOwner,
        stage: 'DELIVER',
        tenantId: input.tenantId,
      });
      await manager.query(
        `
          UPDATE ${this.deliveryOperations}
          SET status = 'UNKNOWN',
              state_version = state_version + 1,
              next_check_at = clock_timestamp(),
              failure_code = 'DESTINATION_OUTCOME_UNKNOWN',
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND status = 'SUBMITTING'
        `,
        [input.tenantId, input.operationId],
      );
      await manager.query(
        `
          UPDATE ${this.attempts}
          SET status = 'TIMED_OUT',
              finished_at = clock_timestamp(),
              failure_code = 'DESTINATION_OUTCOME_UNKNOWN',
              failure_category = 'UNKNOWN_OUTCOME'
          WHERE tenant_id = $1
            AND execution_id = $2
            AND stage = 'DELIVER'
            AND lease_owner = $3
            AND status = 'RUNNING'
        `,
        [input.tenantId, input.executionId, input.leaseOwner],
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
          WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
        `,
        [input.tenantId, input.executionId],
      );
      await manager.query(
        `
          UPDATE ${this.executions}
          SET state_version = state_version + 1,
              failure_code = 'DESTINATION_OUTCOME_UNKNOWN',
              failure_category = 'UNKNOWN_OUTCOME',
              failure_message = 'The destination result could not be confirmed.',
              transitioned_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [input.tenantId, input.executionId, input.expectedStateVersion],
      );
      const message = createMessageEnvelope({
        actor: current.actor,
        causationId: input.causationId,
        correlationId: current.correlationId,
        data: {
          executionId: input.executionId,
          expectedStateVersion: input.expectedStateVersion + 1,
          stage: 'DELIVER',
        },
        projectId: current.projectId,
        tenantId: input.tenantId,
        type: 'aiflow.execution.stage.reconcile.requested.v1',
      });
      await this.outbox.append(queryRunner(manager), {
        aggregateId: input.executionId,
        aggregateType: 'EXECUTION',
        envelope: message,
      });
    });
  }

  async scheduleDeliveryRetry(input: {
    readonly causationId: string;
    readonly code: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockRunningStage(manager, {
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        leaseOwner: input.leaseOwner,
        stage: 'DELIVER',
        tenantId: input.tenantId,
      });
      await manager.query(
        `
          UPDATE ${this.deliveryOperations}
          SET status = 'READY',
              state_version = state_version + 1,
              next_check_at = NULL,
              failure_code = $3,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND status = 'SUBMITTING'
        `,
        [input.tenantId, input.operationId, input.code],
      );
      await manager.query(
        `
          UPDATE ${this.attempts}
          SET status = 'FAILED',
              finished_at = clock_timestamp(),
              failure_code = $4,
              failure_category = 'TRANSIENT'
          WHERE tenant_id = $1
            AND execution_id = $2
            AND stage = 'DELIVER'
            AND lease_owner = $3
            AND status = 'RUNNING'
        `,
        [input.tenantId, input.executionId, input.leaseOwner, input.code],
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
              failure_category = 'TRANSIENT',
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
        `,
        [input.tenantId, input.executionId, input.nextAttemptAt, input.code],
      );
      await manager.query(
        `
          UPDATE ${this.executions}
          SET state_version = state_version + 1,
              failure_code = $4,
              failure_category = 'TRANSIENT',
              failure_message = 'Destination delivery will retry after a bounded delay.',
              transitioned_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [
          input.tenantId,
          input.executionId,
          input.expectedStateVersion,
          input.code,
        ],
      );
      await this.appendAudit(
        manager,
        current,
        input.causationId,
        'execution.stage.retry.schedule',
      );
    });
  }

  async failDelivery(input: {
    readonly causationId: string;
    readonly code: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockRunningStage(manager, {
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        leaseOwner: input.leaseOwner,
        stage: 'DELIVER',
        tenantId: input.tenantId,
      });
      await manager.query(
        `
          UPDATE ${this.deliveryOperations}
          SET status = 'FAILED',
              state_version = state_version + 1,
              failure_code = $3,
              next_check_at = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND status = 'SUBMITTING'
        `,
        [input.tenantId, input.operationId, input.code],
      );
      await manager.query(
        `
          UPDATE ${this.attempts}
          SET status = 'FAILED',
              finished_at = clock_timestamp(),
              failure_code = $4,
              failure_category = 'PERMANENT'
          WHERE tenant_id = $1
            AND execution_id = $2
            AND stage = 'DELIVER'
            AND lease_owner = $3
            AND status = 'RUNNING'
        `,
        [input.tenantId, input.executionId, input.leaseOwner, input.code],
      );
      await manager.query(
        `
          UPDATE ${this.stages}
          SET status = 'FAILED',
              state_version = state_version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              failure_code = $3,
              failure_category = 'PERMANENT',
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
        `,
        [input.tenantId, input.executionId, input.code],
      );
      await manager.query(
        `
          UPDATE ${this.executions}
          SET status = 'FAILED',
              state_version = state_version + 1,
              failure_code = $4,
              failure_category = 'PERMANENT',
              failure_message = 'The destination rejected the mapped input.',
              transitioned_at = clock_timestamp(),
              completed_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [
          input.tenantId,
          input.executionId,
          input.expectedStateVersion,
          input.code,
        ],
      );
      await this.appendAudit(
        manager,
        current,
        input.causationId,
        'execution.fail',
      );
    });
  }

  async deferDeliveryReconciliation(input: {
    readonly nextCheckAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE ${this.deliveryOperations}
        SET next_check_at = $3, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND status = 'UNKNOWN'
      `,
      [input.tenantId, input.operationId, input.nextCheckAt],
    );
  }

  async failUnknownDelivery(input: {
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockWaitingDelivery(
        manager,
        input.tenantId,
        input.executionId,
        input.expectedStateVersion,
      );
      const operations = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.deliveryOperations}
            SET status = 'FAILED',
                state_version = state_version + 1,
                next_check_at = NULL,
                failure_code = 'DESTINATION_RECONCILIATION_DEADLINE_EXCEEDED',
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND status = 'UNKNOWN'
            RETURNING id
          `,
          [input.tenantId, input.operationId],
        ),
      );
      if (operations.length !== 1) {
        throw new Error('DELIVERY_OPERATION_TRANSITION_CONFLICT');
      }
      await manager.query(
        `
          UPDATE ${this.stages}
          SET status = 'FAILED',
              state_version = state_version + 1,
              failure_code = 'DESTINATION_RECONCILIATION_DEADLINE_EXCEEDED',
              failure_category = 'UNKNOWN_OUTCOME',
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
        `,
        [input.tenantId, input.executionId],
      );
      await manager.query(
        `
          UPDATE ${this.executions}
          SET status = 'FAILED',
              state_version = state_version + 1,
              failure_code = 'DESTINATION_RECONCILIATION_DEADLINE_EXCEEDED',
              failure_category = 'UNKNOWN_OUTCOME',
              failure_message = 'The destination result could not be confirmed before the reconciliation deadline.',
              transitioned_at = clock_timestamp(),
              completed_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [input.tenantId, input.executionId, input.expectedStateVersion],
      );
      await this.appendAudit(
        manager,
        current,
        input.causationId,
        'execution.reconciliation.fail',
      );
    });
  }

  async completeUnknownDelivery(input: {
    readonly appliedAt: Date;
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly externalResourceId: string;
    readonly externalResourceNumber: string;
    readonly externalResourceType: string;
    readonly externalVersion: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockWaitingDelivery(
        manager,
        input.tenantId,
        input.executionId,
        input.expectedStateVersion,
      );
      const operation = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.deliveryOperations}
            SET status = 'APPLIED',
                state_version = state_version + 1,
                external_resource_type = $4,
                external_resource_id = $5,
                external_resource_number = $6,
                external_version = $7,
                applied_at = $8,
                next_check_at = NULL,
                failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND current_execution_id = $3
              AND status = 'UNKNOWN'
            RETURNING id
          `,
          [
            input.tenantId,
            input.operationId,
            input.executionId,
            input.externalResourceType,
            input.externalResourceId,
            input.externalResourceNumber,
            input.externalVersion,
            input.appliedAt,
          ],
        ),
      );
      if (operation.length !== 1) {
        throw new Error('DELIVERY_OPERATION_TRANSITION_CONFLICT');
      }
      await manager.query(
        `
          UPDATE ${this.stages}
          SET status = 'SUCCEEDED',
              state_version = state_version + 1,
              failure_code = NULL,
              failure_category = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
        `,
        [input.tenantId, input.executionId],
      );
      await this.finishExecutionSuccess(manager, input, current);
    });
  }

  async resetUnknownDelivery(input: {
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockWaitingDelivery(
        manager,
        input.tenantId,
        input.executionId,
        input.expectedStateVersion,
      );
      await manager.query(
        `
          UPDATE ${this.deliveryOperations}
          SET status = 'READY',
              state_version = state_version + 1,
              next_check_at = NULL,
              failure_code = NULL,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND status = 'UNKNOWN'
        `,
        [input.tenantId, input.operationId],
      );
      await manager.query(
        `
          UPDATE ${this.stages}
          SET status = 'RETRY_SCHEDULED',
              state_version = state_version + 1,
              next_attempt_at = $3,
              failure_code = 'DESTINATION_CONFIRMED_NOT_APPLIED',
              failure_category = 'TRANSIENT',
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
        `,
        [input.tenantId, input.executionId, input.nextAttemptAt],
      );
      await manager.query(
        `
          UPDATE ${this.executions}
          SET state_version = state_version + 1,
              failure_code = 'DESTINATION_CONFIRMED_NOT_APPLIED',
              failure_category = 'TRANSIENT',
              failure_message = 'The destination confirmed that no effect was applied.',
              transitioned_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state_version = $3
        `,
        [input.tenantId, input.executionId, input.expectedStateVersion],
      );
    });
  }

  async acceptExtractionCallback(input: {
    readonly adapterId: string;
    readonly bodySha256: string;
    readonly callbackCorrelationId: string;
    readonly providerEventId: string;
    readonly safeStatus: 'COMPLETED' | 'FAILED';
  }): Promise<'ACCEPTED' | 'DUPLICATE'> {
    return this.dataSource.transaction(async (manager) => {
      const requests = (await manager.query(
        `
          SELECT id, tenant_id, execution_id
          FROM ${this.extractionRequests}
          WHERE adapter_id = $1 AND callback_correlation_id = $2
          FOR UPDATE
        `,
        [input.adapterId, input.callbackCorrelationId],
      )) as { execution_id: string; id: string; tenant_id: string }[];
      const request = requests[0];
      if (request === undefined) {
        throw new Error('EXTRACTION_CALLBACK_TARGET_NOT_FOUND');
      }
      const inserted = mutationRows<{ id: string }>(
        await manager.query(
          `
            INSERT INTO ${this.callbackEvents} (
              id,
              adapter_id,
              provider_event_id,
              extraction_request_id,
              tenant_id,
              body_sha256,
              safe_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (adapter_id, provider_event_id) DO NOTHING
            RETURNING id
          `,
          [
            randomUUID(),
            input.adapterId,
            input.providerEventId,
            request.id,
            request.tenant_id,
            input.bodySha256,
            input.safeStatus,
          ],
        ),
      );
      if (inserted.length === 0) {
        const existing = (await manager.query(
          `
            SELECT body_sha256
            FROM ${this.callbackEvents}
            WHERE adapter_id = $1 AND provider_event_id = $2
          `,
          [input.adapterId, input.providerEventId],
        )) as { body_sha256: string }[];
        if (existing[0]?.body_sha256 !== input.bodySha256) {
          throw new Error('EXTRACTION_CALLBACK_EVENT_CONFLICT');
        }
        return 'DUPLICATE';
      }
      await manager.query(
        `
          UPDATE ${this.extractionRequests}
          SET status = CASE
                WHEN $3 = 'COMPLETED' THEN 'RESULT_AVAILABLE'
                ELSE status
              END,
              state_version = state_version + 1,
              next_check_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = $2
            AND status IN ('SUBMITTING', 'ACCEPTED', 'RESULT_AVAILABLE')
        `,
        [request.tenant_id, request.id, input.safeStatus],
      );
      await manager.query(
        `
          UPDATE ${this.stages}
          SET next_attempt_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND execution_id = $2
            AND stage = 'EXTRACT'
            AND status = 'RETRY_SCHEDULED'
        `,
        [request.tenant_id, request.execution_id],
      );
      return 'ACCEPTED';
    });
  }

  async enqueueDueDeliveryReconciliations(batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new Error('RECOVERY_BATCH_SIZE_INVALID');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT
            operation.id,
            operation.tenant_id,
            operation.project_id,
            operation.current_execution_id AS execution_id,
            execution.state_version,
            execution.actor_type,
            execution.actor_id,
            execution.correlation_id
          FROM ${this.deliveryOperations} AS operation
          JOIN ${this.executions} AS execution
            ON execution.tenant_id = operation.tenant_id
           AND execution.id = operation.current_execution_id
          WHERE operation.status = 'UNKNOWN'
            AND operation.next_check_at <= clock_timestamp()
          ORDER BY operation.next_check_at, operation.id
          LIMIT $1
          FOR UPDATE OF operation SKIP LOCKED
        `,
        [batchSize],
      )) as {
        actor_id: string;
        actor_type: ActorIdentity['type'];
        correlation_id: string;
        execution_id: string;
        id: string;
        project_id: string;
        state_version: number | string;
        tenant_id: string;
      }[];
      for (const row of rows) {
        const message = createMessageEnvelope({
          actor: { id: row.actor_id, type: row.actor_type },
          causationId: row.id,
          correlationId: row.correlation_id,
          data: {
            executionId: row.execution_id,
            expectedStateVersion: Number(row.state_version),
            stage: 'DELIVER',
          },
          projectId: row.project_id,
          tenantId: row.tenant_id,
          type: 'aiflow.execution.stage.reconcile.requested.v1',
        });
        await this.outbox.append(queryRunner(manager), {
          aggregateId: row.execution_id,
          aggregateType: 'EXECUTION',
          envelope: message,
        });
        await manager.query(
          `UPDATE ${this.deliveryOperations} SET next_check_at = clock_timestamp() + interval '30 seconds' WHERE tenant_id = $1 AND id = $2`,
          [row.tenant_id, row.id],
        );
      }
      return rows.length;
    });
  }

  private async insertArtifactReservation(
    manager: EntityManager,
    input: {
      readonly executionId: string;
      readonly projectId: string;
      readonly retentionUntil: Date;
      readonly schemaVersion: number;
      readonly stage: 'EXTRACT' | 'MAP';
      readonly storageObjectId: string;
      readonly tenantId: string;
    },
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO ${this.storageObjects} (
          id,
          tenant_id,
          project_id,
          kind,
          status,
          location_alias,
          object_key,
          retention_until
        ) VALUES ($1, $2, $3, $4, 'RESERVED', 'PRIMARY', $5, $6)
      `,
      [
        input.storageObjectId,
        input.tenantId,
        input.projectId,
        input.stage === 'EXTRACT' ? 'EXTRACTION_RESULT' : 'MAPPING_RESULT',
        buildStorageObjectKey(input.tenantId, input.storageObjectId),
        input.retentionUntil,
      ],
    );
    await manager.query(
      `
        INSERT INTO ${this.artifacts} (
          tenant_id,
          execution_id,
          stage,
          storage_object_id,
          schema_version
        ) VALUES ($1, $2, $3, $4, $5)
      `,
      [
        input.tenantId,
        input.executionId,
        input.stage,
        input.storageObjectId,
        input.schemaVersion,
      ],
    );
  }

  private async makeArtifactAvailable(
    manager: EntityManager,
    input: {
      readonly executionId: string;
      readonly metadata: StoredObjectMetadata;
      readonly payloadSha256: string | undefined;
      readonly stage: 'EXTRACT' | 'MAP';
      readonly tenantId: string;
    },
  ): Promise<ProcessingArtifactRecord> {
    const artifacts = (await manager.query(
      `
        SELECT ${artifactColumns}
        FROM ${this.artifacts} AS artifact
        JOIN ${this.storageObjects} AS storage
          ON storage.tenant_id = artifact.tenant_id
         AND storage.id = artifact.storage_object_id
        WHERE artifact.tenant_id = $1
          AND artifact.execution_id = $2
          AND artifact.stage = $3
        FOR UPDATE OF artifact, storage
      `,
      [input.tenantId, input.executionId, input.stage],
    )) as ArtifactRow[];
    const current = artifacts[0];
    if (current === undefined) {
      throw new Error('PROCESSING_ARTIFACT_NOT_FOUND');
    }
    if (current.status === 'AVAILABLE') {
      const mapped = mapArtifact(current);
      if (
        mapped.metadata?.versionId !== input.metadata.versionId ||
        mapped.metadata.checksum.value !== input.metadata.checksum.value ||
        mapped.payloadSha256 !== input.payloadSha256
      ) {
        throw new Error('PROCESSING_ARTIFACT_CONFLICT');
      }
      return mapped;
    }
    const storage = mutationRows<{ id: string }>(
      await manager.query(
        `
          UPDATE ${this.storageObjects}
          SET status = 'AVAILABLE',
              state_version = state_version + 1,
              version_id = $4,
              size_bytes = $5,
              content_type = $6,
              checksum_algorithm = $7,
              checksum_type = $8,
              checksum_value = $9,
              encryption_mode = $10,
              encryption_key_ref = $11,
              available_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND id = $2
            AND status = 'RESERVED'
            AND object_key = $3
          RETURNING id
        `,
        [
          input.tenantId,
          current.storage_object_id,
          input.metadata.key,
          input.metadata.versionId,
          input.metadata.sizeBytes,
          input.metadata.contentType,
          input.metadata.checksum.algorithm,
          input.metadata.checksum.type,
          input.metadata.checksum.value,
          input.metadata.encryptionMode,
          input.metadata.encryptionKeyRef ?? null,
        ],
      ),
    );
    if (storage.length !== 1) {
      throw new Error('PROCESSING_ARTIFACT_STORAGE_CONFLICT');
    }
    await manager.query(
      `
        UPDATE ${this.artifacts}
        SET status = 'AVAILABLE', payload_sha256 = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND execution_id = $2 AND stage = $3
      `,
      [
        input.tenantId,
        input.executionId,
        input.stage,
        input.payloadSha256 ?? null,
      ],
    );
    return {
      executionId: input.executionId,
      metadata: input.metadata,
      ...(input.payloadSha256 === undefined
        ? {}
        : { payloadSha256: input.payloadSha256 }),
      schemaVersion: Number(current.schema_version),
      stage: input.stage,
      status: 'AVAILABLE',
      storageObjectId: current.storage_object_id,
      tenantId: input.tenantId,
    };
  }

  private async finishArtifactStage(
    manager: EntityManager,
    input: {
      readonly artifact: ProcessingArtifactRecord;
      readonly causationId: string;
      readonly current: LockedExecution;
      readonly executionId: string;
      readonly leaseOwner: string;
      readonly nextStage: 'DELIVER' | 'MAP';
      readonly tenantId: string;
    },
  ): Promise<void> {
    await manager.query(
      `
        UPDATE ${this.attempts}
        SET status = 'SUCCEEDED',
            finished_at = clock_timestamp(),
            output_storage_object_id = $4,
            output_schema_version = $5
        WHERE tenant_id = $1
          AND execution_id = $2
          AND lease_owner = $3
          AND status = 'RUNNING'
      `,
      [
        input.tenantId,
        input.executionId,
        input.leaseOwner,
        input.artifact.storageObjectId,
        input.artifact.schemaVersion,
      ],
    );
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
        WHERE tenant_id = $1 AND execution_id = $2 AND stage = $3
      `,
      [input.tenantId, input.executionId, input.current.currentStage],
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
            transitioned_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND state_version = $3
      `,
      [
        input.tenantId,
        input.executionId,
        input.current.stateVersion,
        input.nextStage === 'MAP' ? 'MAPPING' : 'DELIVERING',
        input.nextStage,
      ],
    );
    const message = createMessageEnvelope({
      actor: input.current.actor,
      causationId: input.causationId,
      correlationId: input.current.correlationId,
      data: {
        ...(input.nextStage === 'DELIVER'
          ? { connectorId: input.current.destinationConnectorId }
          : {}),
        executionId: input.executionId,
        expectedStateVersion: input.current.stateVersion + 1,
        stage: input.nextStage,
      },
      projectId: input.current.projectId,
      tenantId: input.tenantId,
      type:
        input.nextStage === 'MAP'
          ? 'aiflow.execution.stage.map.requested.v1'
          : `aiflow.execution.stage.deliver.connector.${input.current.destinationConnectorId}.requested.v1`,
    });
    await this.outbox.append(queryRunner(manager), {
      aggregateId: input.executionId,
      aggregateType: 'EXECUTION',
      envelope: message,
    });
    await this.appendAudit(
      manager,
      input.current,
      input.causationId,
      'execution.stage.complete',
    );
  }

  private async finishTerminalDelivery(
    manager: EntityManager,
    input: {
      readonly causationId: string;
      readonly executionId: string;
      readonly expectedStateVersion: number;
      readonly leaseOwner: string;
      readonly tenantId: string;
    },
    current: LockedExecution,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE ${this.attempts}
        SET status = 'SUCCEEDED', finished_at = clock_timestamp()
        WHERE tenant_id = $1
          AND execution_id = $2
          AND stage = 'DELIVER'
          AND lease_owner = $3
          AND status = 'RUNNING'
      `,
      [input.tenantId, input.executionId, input.leaseOwner],
    );
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
        WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
      `,
      [input.tenantId, input.executionId],
    );
    await this.finishExecutionSuccess(manager, input, current);
  }

  private async finishExecutionSuccess(
    manager: EntityManager,
    input: {
      readonly causationId: string;
      readonly executionId: string;
      readonly expectedStateVersion: number;
      readonly tenantId: string;
    },
    current: LockedExecution,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE ${this.executions}
        SET status = 'SUCCEEDED',
            state_version = state_version + 1,
            failure_code = NULL,
            failure_category = NULL,
            failure_message = NULL,
            transitioned_at = clock_timestamp(),
            completed_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND state_version = $3
      `,
      [input.tenantId, input.executionId, input.expectedStateVersion],
    );
    await this.appendAudit(
      manager,
      current,
      input.causationId,
      'execution.succeed',
    );
  }

  private async requireRunningAttempt(
    manager: EntityManager,
    input: {
      readonly executionId: string;
      readonly leaseOwner: string;
      readonly stage: 'EXTRACT' | 'MAP';
      readonly stageAttemptId: string;
      readonly tenantId: string;
    },
  ): Promise<void> {
    const rows = (await manager.query(
      `
        SELECT id
        FROM ${this.attempts}
        WHERE tenant_id = $1
          AND execution_id = $2
          AND id = $3
          AND stage = $4
          AND lease_owner = $5
          AND status = 'RUNNING'
        FOR UPDATE
      `,
      [
        input.tenantId,
        input.executionId,
        input.stageAttemptId,
        input.stage,
        input.leaseOwner,
      ],
    )) as { id: string }[];
    if (rows.length !== 1) {
      throw new Error('STAGE_ATTEMPT_LEASE_MISMATCH');
    }
  }

  private async requireRunningStage(
    manager: EntityManager,
    input: {
      readonly executionId: string;
      readonly leaseOwner: string;
      readonly stage: 'DELIVER';
      readonly tenantId: string;
    },
  ): Promise<void> {
    const rows = (await manager.query(
      `
        SELECT id
        FROM ${this.stages}
        WHERE tenant_id = $1
          AND execution_id = $2
          AND stage = $3
          AND lease_owner = $4
          AND status = 'RUNNING'
        FOR UPDATE
      `,
      [input.tenantId, input.executionId, input.stage, input.leaseOwner],
    )) as { id: string }[];
    if (rows.length !== 1) {
      throw new Error('STAGE_LEASE_MISMATCH');
    }
  }

  private async lockRunningStage(
    manager: EntityManager,
    input: {
      readonly executionId: string;
      readonly expectedStateVersion: number;
      readonly leaseOwner: string;
      readonly stage: 'DELIVER' | 'EXTRACT' | 'MAP';
      readonly tenantId: string;
    },
  ): Promise<LockedExecution> {
    const rows = (await manager.query(
      `
        SELECT
          execution.state_version,
          execution.id AS execution_id,
          execution.tenant_id,
          execution.current_stage,
          execution.project_id,
          execution.root_execution_id,
          execution.document_id,
          execution.actor_type,
          execution.actor_id,
          execution.correlation_id,
          execution.workflow_version_id,
          version.definition #>> '{destination,connectorId}' AS destination_connector_id,
          version.definition #>> '{destination,actionId}' AS destination_action_id,
          version.definition #>> '{destination,config,companyId}' AS destination_company_resource_id
        FROM ${this.executions} AS execution
        JOIN ${this.versions} AS version
          ON version.tenant_id = execution.tenant_id
         AND version.id = execution.workflow_version_id
        JOIN ${this.stages} AS stage
          ON stage.tenant_id = execution.tenant_id
         AND stage.execution_id = execution.id
         AND stage.stage = $4
        WHERE execution.tenant_id = $1
          AND execution.id = $2
          AND execution.state_version = $3
          AND execution.current_stage = $4
          AND execution.status NOT IN ('SUCCEEDED', 'FAILED', 'REJECTED')
          AND stage.status = 'RUNNING'
          AND stage.lease_owner = $5
          AND stage.lease_expires_at > clock_timestamp()
        FOR UPDATE OF execution, stage
      `,
      [
        input.tenantId,
        input.executionId,
        input.expectedStateVersion,
        input.stage,
        input.leaseOwner,
      ],
    )) as LockedExecutionRow[];
    if (rows[0] === undefined) {
      throw new Error('STAGE_LEASE_MISMATCH');
    }
    return mapLockedExecution(rows[0]);
  }

  private async lockWaitingDelivery(
    manager: EntityManager,
    tenantId: string,
    executionId: string,
    expectedStateVersion: number,
  ): Promise<LockedExecution> {
    const rows = (await manager.query(
      `
        SELECT
          execution.state_version,
          execution.id AS execution_id,
          execution.tenant_id,
          execution.current_stage,
          execution.project_id,
          execution.root_execution_id,
          execution.document_id,
          execution.actor_type,
          execution.actor_id,
          execution.correlation_id,
          execution.workflow_version_id,
          version.definition #>> '{destination,connectorId}' AS destination_connector_id,
          version.definition #>> '{destination,actionId}' AS destination_action_id,
          version.definition #>> '{destination,config,companyId}' AS destination_company_resource_id
        FROM ${this.executions} AS execution
        JOIN ${this.versions} AS version
          ON version.tenant_id = execution.tenant_id
         AND version.id = execution.workflow_version_id
        JOIN ${this.stages} AS stage
          ON stage.tenant_id = execution.tenant_id
         AND stage.execution_id = execution.id
         AND stage.stage = 'DELIVER'
        WHERE execution.tenant_id = $1
          AND execution.id = $2
          AND execution.state_version = $3
          AND execution.current_stage = 'DELIVER'
          AND stage.status = 'WAITING'
        FOR UPDATE OF execution, stage
      `,
      [tenantId, executionId, expectedStateVersion],
    )) as LockedExecutionRow[];
    if (rows[0] === undefined) {
      throw new Error('DELIVERY_RECONCILIATION_STALE');
    }
    return mapLockedExecution(rows[0]);
  }

  private async appendAudit(
    manager: EntityManager,
    execution: LockedExecution,
    causationId: string,
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
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'EXECUTION', $7, 'SUCCEEDED', $8, $9, $10
        )
      `,
      [
        randomUUID(),
        execution.tenantId,
        execution.projectId,
        execution.actor.type,
        execution.actor.id,
        action,
        execution.executionId,
        execution.correlationId,
        causationId,
        execution.workflowVersionId,
      ],
    );
  }
}

interface LockedExecutionRow {
  actor_id: string;
  actor_type: ActorIdentity['type'];
  correlation_id: string;
  current_stage: 'DELIVER' | 'EXTRACT' | 'MAP';
  destination_action_id: string;
  destination_company_resource_id: string;
  destination_connector_id: string;
  document_id: string;
  execution_id: string;
  project_id: string;
  root_execution_id: string;
  state_version: number | string;
  tenant_id: string;
  workflow_version_id: string;
}

interface LockedExecution {
  readonly actor: ActorIdentity;
  readonly correlationId: string;
  readonly currentStage: 'DELIVER' | 'EXTRACT' | 'MAP';
  readonly destinationActionId: string;
  readonly destinationCompanyResourceId: string;
  readonly destinationConnectorId: string;
  readonly documentId: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly rootExecutionId: string;
  readonly stateVersion: number;
  readonly tenantId: string;
  readonly workflowVersionId: string;
}

const mapLockedExecution = (row: LockedExecutionRow): LockedExecution => ({
  actor: { id: row.actor_id, type: row.actor_type },
  correlationId: row.correlation_id,
  currentStage: row.current_stage,
  destinationActionId: row.destination_action_id,
  destinationCompanyResourceId: row.destination_company_resource_id,
  destinationConnectorId: row.destination_connector_id,
  documentId: row.document_id,
  executionId: row.execution_id,
  projectId: row.project_id,
  rootExecutionId: row.root_execution_id,
  stateVersion: Number(row.state_version),
  tenantId: row.tenant_id,
  workflowVersionId: row.workflow_version_id,
});
