import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import {
  loadDatabaseMigrationConfig,
  loadDatabaseRuntimeConfig,
  type DatabaseRuntimeConfig,
} from '@aiflow/config';
import {
  buildStorageObjectKey,
  type CreateUploadSessionInput,
} from '@aiflow/storage';
import type { ValidatedWorkflowDefinition } from '@aiflow/workflows';

import { createApplicationDataSource } from './data-source';
import { runDatabaseMigrations } from './migration-runner';
import { PostgresExecutionRepository } from './execution.repository';
import { PostgresPipelineRepository } from './pipeline.repository';
import { PostgresExecutionRecoveryRepository } from './scheduler.repository';
import { PostgresUploadSessionRepository } from './upload-session.repository';
import { PostgresWorkflowProvisioningRepository } from './workflow-provisioning.repository';
import { PostgresWorkflowRepository } from './workflow.repository';

const connectionUrl = (
  container: StartedPostgreSqlContainer,
  username: string,
  password: string,
): string => {
  const url = new URL(container.getConnectionUri());
  url.username = username;
  url.password = password;
  return url.toString();
};

const validatedDefinition: ValidatedWorkflowDefinition = {
  connectionReferences: [],
  definition: {
    destination: {
      actionId: 'complete',
      config: {},
      connectorId: 'synthetic',
    },
    entry: { config: {}, connectorId: 'direct-upload' },
    extraction: { config: {}, profileId: 'synthetic-profile' },
    mappings: [{ sourceField: 'value', targetField: 'value' }],
    reviewPolicy: { required: false },
    schemaVersion: 1,
  },
  definitionHash: 'a'.repeat(64),
  profileReference: {
    outputSchemaHash: 'b'.repeat(64),
    profileId: 'synthetic-profile',
    profileKind: 'SYSTEM',
    profileVersionId: 'synthetic-profile-v1',
  },
};

const phase2Definition: ValidatedWorkflowDefinition = {
  connectionReferences: [],
  definition: {
    destination: {
      actionId: 'create-purchase-invoice-draft',
      config: { companyId: 'fake-company-1' },
      connectorId: 'microsoft-business-central',
    },
    entry: { config: {}, connectorId: 'direct-upload' },
    extraction: { config: {}, profileId: 'invoice-basic' },
    mappings: [
      {
        required: true,
        sourceField: 'invoice_number',
        targetField: 'vendorInvoiceNumber',
      },
    ],
    reviewPolicy: { required: false },
    schemaVersion: 1,
  },
  definitionHash: 'c'.repeat(64),
  profileReference: {
    outputSchemaHash: 'd'.repeat(64),
    profileId: 'invoice-basic',
    profileKind: 'SYSTEM',
    profileVersionId: 'invoice-basic-v1',
  },
};

describe('PostgreSQL upload sessions', () => {
  let container: StartedPostgreSqlContainer;
  let runtimeConfig: DatabaseRuntimeConfig;
  let runtimeDataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.4-bookworm')
      .withDatabase('aiflow')
      .withUsername('aiflow_bootstrap')
      .withPassword('local-bootstrap-only')
      .withCopyFilesToContainer([
        {
          source: resolve(
            process.cwd(),
            'infra/postgres/init/001-create-local-identities.sql',
          ),
          target: '/docker-entrypoint-initdb.d/001-create-local-identities.sql',
        },
      ])
      .start();
    const migrationConfig = loadDatabaseMigrationConfig({
      DATABASE_MIGRATION_URL: connectionUrl(
        container,
        'aiflow_migration',
        'local-migration-only',
      ),
      NODE_ENV: 'test',
    });
    runtimeConfig = loadDatabaseRuntimeConfig({
      DATABASE_POOL_MAX: '5',
      DATABASE_URL: connectionUrl(
        container,
        'aiflow_app',
        'local-application-only',
      ),
      NODE_ENV: 'test',
    });
    await runDatabaseMigrations(migrationConfig);
    runtimeDataSource = createApplicationDataSource(runtimeConfig, 'api');
    await runtimeDataSource.initialize();
  });

  afterAll(async () => {
    if (runtimeDataSource?.isInitialized) {
      await runtimeDataSource.destroy();
    }
    await container?.stop();
  });

  const activateWorkflow = async (
    tenantId: string,
    projectId: string,
    definition: ValidatedWorkflowDefinition = validatedDefinition,
  ): Promise<{ readonly versionId: string; readonly workflowId: string }> => {
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const provisioning = new PostgresWorkflowProvisioningRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const workflowId = randomUUID();
    const versionId = randomUUID();
    await workflows.create({
      actor: { id: 'upload-test-user', type: 'USER' },
      causationId: randomUUID(),
      correlationId: randomUUID(),
      definition,
      name: 'Upload test workflow',
      projectId,
      tenantId,
      versionId,
      workflowId,
    });
    const operation = await provisioning.requestActivation({
      actor: { id: 'upload-test-user', type: 'USER' },
      causationId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      operationId: randomUUID(),
      projectId,
      targetVersionId: versionId,
      tenantId,
      workflowId,
    });
    const claimed = await provisioning.claim({
      consumerName: 'upload-test-provisioner',
      expectedStateVersion: 0,
      leaseDurationMs: 30_000,
      leaseOwner: 'upload-test-worker',
      messageId: randomUUID(),
      messageType: 'aiflow.workflow.provisioning.requested.v1',
      operationId: operation.id,
      projectId,
      tenantId,
    });
    if (claimed === undefined) {
      throw new Error('TEST_WORKFLOW_ACTIVATION_NOT_CLAIMED');
    }
    await provisioning.completeActivation({
      expectedStateVersion: claimed.stateVersion,
      leaseOwner: 'upload-test-worker',
      operationId: operation.id,
      tenantId,
    });
    return { versionId, workflowId };
  };

  const createInput = (
    tenantId: string,
    projectId: string,
    workflowId: string,
  ): CreateUploadSessionInput => ({
    actor: { id: 'upload-test-user', type: 'USER' },
    causationId: randomUUID(),
    clientChecksumValue: Buffer.alloc(32, 3).toString('base64'),
    contentType: 'application/pdf',
    correlationId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    idempotencyKey: randomUUID(),
    originalFilename: 'invoice.pdf',
    plan: { type: 'SINGLE_PUT' },
    projectId,
    retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    sizeBytes: 1024,
    storageObjectId: randomUUID(),
    tenantId,
    uploadSessionId: randomUUID(),
    workflowId,
  });

  it('creates the reservation idempotently and keeps tenant scope strict', async () => {
    const tenantId = 'upload-tenant-a';
    const projectId = 'upload-project-a';
    const { versionId, workflowId } = await activateWorkflow(
      tenantId,
      projectId,
    );
    const sessions = new PostgresUploadSessionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const input = createInput(tenantId, projectId, workflowId);

    const created = await sessions.create(input);
    expect(created).toMatchObject({
      id: input.uploadSessionId,
      stateVersion: 0,
      status: 'ACTIVE',
      storageObjectId: input.storageObjectId,
      workflowVersionId: versionId,
    });
    await expect(
      sessions.create({
        ...input,
        storageObjectId: randomUUID(),
        uploadSessionId: randomUUID(),
      }),
    ).resolves.toMatchObject({ id: input.uploadSessionId });
    await expect(
      sessions.create({
        ...input,
        sizeBytes: input.sizeBytes + 1,
        storageObjectId: randomUUID(),
        uploadSessionId: randomUUID(),
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    await expect(
      sessions.findById('different-tenant', input.uploadSessionId),
    ).resolves.toBeUndefined();
    await expect(
      sessions.create({
        ...createInput('different-tenant', projectId, workflowId),
      }),
    ).rejects.toThrow('WORKFLOW_NOT_ACCEPTING_DOCUMENTS');

    const [storage] = (await runtimeDataSource.query(
      `
        SELECT status
        FROM aiflow.storage_objects
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, input.storageObjectId],
    )) as { status: string }[];
    expect(storage?.status).toBe('RESERVED');
  });

  it('binds multipart state once and abandons storage atomically on abort', async () => {
    const tenantId = 'upload-tenant-b';
    const projectId = 'upload-project-b';
    const { workflowId } = await activateWorkflow(tenantId, projectId);
    const sessions = new PostgresUploadSessionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const input: CreateUploadSessionInput = {
      ...createInput(tenantId, projectId, workflowId),
      plan: { partCount: 3, partSizeBytes: 512, type: 'MULTIPART' },
      sizeBytes: 1280,
    };
    const created = await sessions.create(input);
    const mutation = {
      actor: input.actor,
      causationId: randomUUID(),
      correlationId: randomUUID(),
      expectedStateVersion: created.stateVersion,
      multipartUploadReference: 'opaque-multipart-reference',
      tenantId,
      uploadSessionId: created.id,
    };

    const attached = await sessions.attachMultipartUpload(mutation);
    expect(attached).toMatchObject({
      multipartUploadReference: mutation.multipartUploadReference,
      stateVersion: 1,
    });
    await expect(
      sessions.attachMultipartUpload(mutation),
    ).resolves.toMatchObject({ stateVersion: 1 });

    const partChecksum = Buffer.alloc(32, 8).toString('base64');
    const partInput = {
      actor: input.actor,
      causationId: randomUUID(),
      checksumValue: partChecksum,
      contentLength: 512,
      correlationId: randomUUID(),
      partNumber: 1,
      tenantId,
      uploadSessionId: created.id,
    };
    const pinned = await sessions.pinPart(partInput);
    expect(pinned).toMatchObject({
      part: {
        checksum: { algorithm: 'SHA256', value: partChecksum },
        partNumber: 1,
        sizeBytes: 512,
      },
      session: { id: created.id, stateVersion: 1 },
    });
    await expect(sessions.pinPart(partInput)).resolves.toMatchObject({
      part: { checksum: { value: partChecksum }, partNumber: 1 },
    });
    await expect(
      sessions.pinPart({
        ...partInput,
        checksumValue: Buffer.alloc(32, 9).toString('base64'),
      }),
    ).rejects.toThrow('UPLOAD_PART_CONFLICT');
    await expect(
      sessions.pinPart({
        ...partInput,
        contentLength: 512,
        partNumber: 3,
      }),
    ).rejects.toThrow('UPLOAD_PART_SIZE_MISMATCH');
    await expect(
      sessions.pinPart({
        ...partInput,
        tenantId: 'different-tenant',
      }),
    ).rejects.toThrow('UPLOAD_SESSION_NOT_FOUND');

    const aborted = await sessions.abort({
      ...mutation,
      expectedStateVersion: attached.stateVersion,
    });
    expect(aborted).toMatchObject({ stateVersion: 2, status: 'ABORTED' });
    await expect(
      sessions.abort({
        ...mutation,
        expectedStateVersion: attached.stateVersion,
      }),
    ).resolves.toMatchObject({ stateVersion: 2, status: 'ABORTED' });

    const [storage] = (await runtimeDataSource.query(
      `
        SELECT failure_code, status
        FROM aiflow.storage_objects
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, input.storageObjectId],
    )) as { failure_code: string; status: string }[];
    expect(storage).toEqual({
      failure_code: 'UPLOAD_SESSION_ABORTED',
      status: 'ABANDONED',
    });
  });

  it('atomically stages one verified upload and returns the durable result on retry', async () => {
    const tenantId = 'upload-tenant-c';
    const projectId = 'upload-project-c';
    const { workflowId } = await activateWorkflow(tenantId, projectId);
    const sessions = new PostgresUploadSessionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const input = createInput(tenantId, projectId, workflowId);
    const created = await sessions.create(input);
    const documentId = randomUUID();
    const executionId = randomUUID();
    const idempotencyKey = randomUUID();
    const completion = {
      actor: input.actor,
      causationId: randomUUID(),
      correlationId: randomUUID(),
      documentId,
      executionId,
      idempotencyKey,
      metadata: {
        checksum: {
          algorithm: 'SHA256' as const,
          type: 'FULL_OBJECT' as const,
          value: input.clientChecksumValue,
        },
        contentType: input.contentType,
        encryptionMode: 'AES256',
        key: buildStorageObjectKey(tenantId, input.storageObjectId),
        sizeBytes: input.sizeBytes,
        versionId: 'source-version-1',
      },
      tenantId,
      uploadSessionId: created.id,
    };

    const completed = await sessions.commitCompletion(completion);
    expect(completed).toMatchObject({
      documentId,
      executionId,
      session: { stateVersion: 1, status: 'COMPLETED' },
    });
    await expect(
      sessions.commitCompletion({
        ...completion,
        documentId: randomUUID(),
        executionId: randomUUID(),
      }),
    ).resolves.toMatchObject({ documentId, executionId });

    const [storage] = (await runtimeDataSource.query(
      `
        SELECT checksum_type, checksum_value, status, version_id
        FROM aiflow.storage_objects
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, input.storageObjectId],
    )) as {
      checksum_type: string;
      checksum_value: string;
      status: string;
      version_id: string;
    }[];
    expect(storage).toEqual({
      checksum_type: 'FULL_OBJECT',
      checksum_value: input.clientChecksumValue,
      status: 'AVAILABLE',
      version_id: completion.metadata.versionId,
    });

    const documents = (await runtimeDataSource.query(
      `
        SELECT id, source_identity, source_storage_object_id, source_version
        FROM aiflow.documents
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, documentId],
    )) as {
      id: string;
      source_identity: string;
      source_storage_object_id: string;
      source_version: string;
    }[];
    expect(documents).toEqual([
      {
        id: documentId,
        source_identity: created.id,
        source_storage_object_id: input.storageObjectId,
        source_version: completion.metadata.versionId,
      },
    ]);

    const executions = (await runtimeDataSource.query(
      `
        SELECT current_stage, document_id, id, status
        FROM aiflow.executions
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, executionId],
    )) as {
      current_stage: string;
      document_id: string;
      id: string;
      status: string;
    }[];
    expect(executions).toEqual([
      {
        current_stage: 'EXTRACT',
        document_id: documentId,
        id: executionId,
        status: 'QUEUED',
      },
    ]);

    const stages = (await runtimeDataSource.query(
      `
        SELECT stage, status
        FROM aiflow.execution_stages
        WHERE tenant_id = $1 AND execution_id = $2
        ORDER BY stage
      `,
      [tenantId, executionId],
    )) as { stage: string; status: string }[];
    expect(stages).toEqual([
      { stage: 'DELIVER', status: 'PENDING' },
      { stage: 'EXTRACT', status: 'PENDING' },
      { stage: 'MAP', status: 'PENDING' },
      { stage: 'REVIEW', status: 'SKIPPED' },
    ]);

    const [effects] = (await runtimeDataSource.query(
      `
        SELECT
          (SELECT count(*)::int FROM aiflow.documents
            WHERE tenant_id = $1 AND source_identity = $2) AS document_count,
          (SELECT count(*)::int FROM aiflow.executions
            WHERE tenant_id = $1 AND document_id = $3) AS execution_count,
          (SELECT count(*)::int FROM aiflow.outbox_messages
            WHERE tenant_id = $1 AND aggregate_id = $4::text) AS outbox_count,
          (SELECT count(*)::int FROM aiflow.audit_events
            WHERE tenant_id = $1
              AND resource_id IN ($2::text, $4::text)
              AND action IN ('upload-session.completed', 'execution.create')) AS audit_count
      `,
      [tenantId, created.id, documentId, executionId],
    )) as {
      audit_count: number;
      document_count: number;
      execution_count: number;
      outbox_count: number;
    }[];
    expect(effects).toEqual({
      audit_count: 2,
      document_count: 1,
      execution_count: 1,
      outbox_count: 1,
    });
  });

  it('rolls back every staging effect when the workflow stops accepting documents', async () => {
    const tenantId = 'upload-tenant-d';
    const projectId = 'upload-project-d';
    const { workflowId } = await activateWorkflow(tenantId, projectId);
    const sessions = new PostgresUploadSessionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const input = createInput(tenantId, projectId, workflowId);
    const created = await sessions.create(input);
    await runtimeDataSource.query(
      `
        UPDATE aiflow.workflows
        SET active_version_id = NULL,
            accepting_new_documents = false,
            status = 'INACTIVE'
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, workflowId],
    );
    const documentId = randomUUID();
    const executionId = randomUUID();

    await expect(
      sessions.commitCompletion({
        actor: input.actor,
        causationId: randomUUID(),
        correlationId: randomUUID(),
        documentId,
        executionId,
        idempotencyKey: randomUUID(),
        metadata: {
          checksum: {
            algorithm: 'SHA256',
            type: 'FULL_OBJECT',
            value: input.clientChecksumValue,
          },
          contentType: input.contentType,
          encryptionMode: 'AES256',
          key: buildStorageObjectKey(tenantId, input.storageObjectId),
          sizeBytes: input.sizeBytes,
          versionId: 'source-version-cutover',
        },
        tenantId,
        uploadSessionId: created.id,
      }),
    ).rejects.toThrow('WORKFLOW_NOT_ACCEPTING_DOCUMENTS');

    const [state] = (await runtimeDataSource.query(
      `
        SELECT
          (SELECT status FROM aiflow.upload_sessions
            WHERE tenant_id = $1 AND id = $2) AS session_status,
          (SELECT status FROM aiflow.storage_objects
            WHERE tenant_id = $1 AND id = $3) AS storage_status,
          (SELECT count(*)::int FROM aiflow.documents
            WHERE tenant_id = $1 AND id = $4) AS document_count,
          (SELECT count(*)::int FROM aiflow.executions
            WHERE tenant_id = $1 AND id = $5) AS execution_count,
          (SELECT count(*)::int FROM aiflow.outbox_messages
            WHERE tenant_id = $1 AND aggregate_id = $5::text) AS outbox_count,
          (SELECT count(*)::int FROM aiflow.idempotency_records
            WHERE tenant_id = $1
              AND operation_scope = 'upload-session.complete') AS completion_key_count
      `,
      [tenantId, created.id, input.storageObjectId, documentId, executionId],
    )) as {
      completion_key_count: number;
      document_count: number;
      execution_count: number;
      outbox_count: number;
      session_status: string;
      storage_status: string;
    }[];
    expect(state).toEqual({
      completion_key_count: 0,
      document_count: 0,
      execution_count: 0,
      outbox_count: 0,
      session_status: 'ACTIVE',
      storage_status: 'RESERVED',
    });
  });

  it('commits extraction, mapping, and one effective-once delivery lifecycle', async () => {
    const tenantId = 'upload-tenant-pipeline';
    const projectId = 'upload-project-pipeline';
    const { workflowId } = await activateWorkflow(
      tenantId,
      projectId,
      phase2Definition,
    );
    const uploads = new PostgresUploadSessionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const executions = new PostgresExecutionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const pipeline = new PostgresPipelineRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const upload = createInput(tenantId, projectId, workflowId);
    const session = await uploads.create(upload);
    const documentId = randomUUID();
    const executionId = randomUUID();
    await uploads.commitCompletion({
      actor: upload.actor,
      causationId: randomUUID(),
      correlationId: randomUUID(),
      documentId,
      executionId,
      idempotencyKey: randomUUID(),
      metadata: {
        checksum: {
          algorithm: 'SHA256',
          type: 'FULL_OBJECT',
          value: upload.clientChecksumValue,
        },
        contentType: upload.contentType,
        encryptionMode: 'AES256',
        key: buildStorageObjectKey(tenantId, upload.storageObjectId),
        sizeBytes: upload.sizeBytes,
        versionId: 'source-version-pipeline',
      },
      tenantId,
      uploadSessionId: session.id,
    });

    const extractLeaseOwner = 'pipeline-extract-worker';
    const extractClaim = await executions.claimStage({
      consumerName: 'pipeline-extract-consumer',
      expectedStateVersion: 0,
      executionId,
      leaseDurationMs: 30_000,
      leaseOwner: extractLeaseOwner,
      messageId: randomUUID(),
      messageType: 'aiflow.execution.stage.extract.requested.v1',
      projectId,
      stage: 'EXTRACT',
      tenantId,
    });
    if (extractClaim === undefined) {
      throw new Error('TEST_EXTRACT_NOT_CLAIMED');
    }
    const context = await pipeline.loadWorkContext(tenantId, executionId);
    expect(context).toMatchObject({
      contentSha256: Buffer.from(upload.clientChecksumValue, 'base64').toString(
        'hex',
      ),
      source: { versionId: 'source-version-pipeline' },
    });
    const extractionRequestId = randomUUID();
    const extractionStorageObjectId = randomUUID();
    const callbackCorrelationId = randomUUID();
    const extraction = await pipeline.prepareExtraction({
      adapterId: 'fake-extraction',
      callbackCorrelationId,
      deadlineAt: new Date(Date.now() + 30 * 60 * 1_000),
      executionId,
      extractionRequestId,
      leaseOwner: extractLeaseOwner,
      nextCheckAt: new Date(),
      profileId: 'invoice-basic',
      profileVersionId: 'invoice-basic-v1',
      projectId,
      resultStorageObjectId: extractionStorageObjectId,
      retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      stageAttemptId: extractClaim.attempt.attemptId,
      tenantId,
    });
    await pipeline.recordExtractionAccepted({
      nextCheckAt: new Date(),
      providerOperationRef: 'fake-operation-1',
      requestId: extraction.request.id,
      tenantId,
    });
    await expect(
      pipeline.acceptExtractionCallback({
        adapterId: 'fake-extraction',
        bodySha256: 'a'.repeat(64),
        callbackCorrelationId,
        providerEventId: 'fake-event-1',
        safeStatus: 'COMPLETED',
      }),
    ).resolves.toBe('ACCEPTED');
    await expect(
      pipeline.acceptExtractionCallback({
        adapterId: 'fake-extraction',
        bodySha256: 'a'.repeat(64),
        callbackCorrelationId,
        providerEventId: 'fake-event-1',
        safeStatus: 'COMPLETED',
      }),
    ).resolves.toBe('DUPLICATE');
    await expect(
      pipeline.acceptExtractionCallback({
        adapterId: 'fake-extraction',
        bodySha256: 'b'.repeat(64),
        callbackCorrelationId,
        providerEventId: 'fake-event-1',
        safeStatus: 'COMPLETED',
      }),
    ).rejects.toThrow('EXTRACTION_CALLBACK_EVENT_CONFLICT');
    const extractionChecksum = Buffer.alloc(32, 11).toString('base64');
    await pipeline.completeExtraction({
      causationId: randomUUID(),
      executionId,
      expectedStateVersion: extractClaim.execution.stateVersion,
      leaseOwner: extractLeaseOwner,
      metadata: {
        checksum: {
          algorithm: 'SHA256',
          type: 'FULL_OBJECT',
          value: extractionChecksum,
        },
        contentType: 'application/json',
        encryptionMode: 'AES256',
        key: buildStorageObjectKey(tenantId, extractionStorageObjectId),
        sizeBytes: 512,
        versionId: 'extraction-version-1',
      },
      requestId: extractionRequestId,
      tenantId,
    });

    const afterExtraction = await executions.findById(tenantId, executionId);
    expect(afterExtraction).toMatchObject({
      currentStage: 'MAP',
      stateVersion: 2,
      status: 'MAPPING',
    });
    const mapLeaseOwner = 'pipeline-map-worker';
    const mapClaim = await executions.claimStage({
      consumerName: 'pipeline-map-consumer',
      expectedStateVersion: 2,
      executionId,
      leaseDurationMs: 30_000,
      leaseOwner: mapLeaseOwner,
      messageId: randomUUID(),
      messageType: 'aiflow.execution.stage.map.requested.v1',
      projectId,
      stage: 'MAP',
      tenantId,
    });
    if (mapClaim === undefined) {
      throw new Error('TEST_MAP_NOT_CLAIMED');
    }
    const mappingStorageObjectId = randomUUID();
    await pipeline.prepareMappingArtifact({
      executionId,
      leaseOwner: mapLeaseOwner,
      projectId,
      retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      stageAttemptId: mapClaim.attempt.attemptId,
      storageObjectId: mappingStorageObjectId,
      tenantId,
    });
    const payloadSha256 = 'e'.repeat(64);
    await pipeline.completeMapping({
      actionId: 'create-purchase-invoice-draft',
      actionVersion: 1,
      causationId: randomUUID(),
      companyResourceId: 'fake-company-1',
      connectorId: 'microsoft-business-central',
      deliveryOperationId: randomUUID(),
      effectKey: randomUUID(),
      executionId,
      expectedStateVersion: mapClaim.execution.stateVersion,
      leaseOwner: mapLeaseOwner,
      metadata: {
        checksum: {
          algorithm: 'SHA256',
          type: 'FULL_OBJECT',
          value: Buffer.alloc(32, 12).toString('base64'),
        },
        contentType: 'application/json',
        encryptionMode: 'AES256',
        key: buildStorageObjectKey(tenantId, mappingStorageObjectId),
        sizeBytes: 256,
        versionId: 'mapping-version-1',
      },
      payloadSha256,
      reconciliationDeadlineAt: new Date(Date.now() + 15 * 60 * 1_000),
      tenantId,
    });
    const delivery = await pipeline.findDelivery(tenantId, executionId);
    expect(delivery).toMatchObject({
      companyResourceId: 'fake-company-1',
      payloadSha256,
      status: 'READY',
    });
    if (delivery === undefined) {
      throw new Error('TEST_DELIVERY_NOT_FOUND');
    }

    const deliverLeaseOwner = 'pipeline-deliver-worker';
    const deliverClaim = await executions.claimStage({
      consumerName: 'pipeline-deliver-consumer',
      expectedStateVersion: 4,
      executionId,
      leaseDurationMs: 30_000,
      leaseOwner: deliverLeaseOwner,
      messageId: randomUUID(),
      messageType:
        'aiflow.execution.stage.deliver.connector.microsoft-business-central.requested.v1',
      projectId,
      stage: 'DELIVER',
      tenantId,
    });
    if (deliverClaim === undefined) {
      throw new Error('TEST_DELIVERY_NOT_CLAIMED');
    }
    const submitting = await pipeline.startDelivery({
      executionId,
      expectedOperationStateVersion: delivery.stateVersion,
      leaseOwner: deliverLeaseOwner,
      operationId: delivery.id,
      tenantId,
    });
    expect(submitting.status).toBe('SUBMITTING');
    await runtimeDataSource.query(
      `
        UPDATE aiflow.execution_stages
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND execution_id = $2 AND stage = 'DELIVER'
      `,
      [tenantId, executionId],
    );
    const recovery = new PostgresExecutionRecoveryRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    await expect(recovery.recoverExpiredLeases(10, 1_000)).resolves.toEqual({
      processed: 1,
    });
    await expect(
      pipeline.findDelivery(tenantId, executionId),
    ).resolves.toMatchObject({ status: 'UNKNOWN' });
    await pipeline.completeUnknownDelivery({
      appliedAt: new Date(),
      causationId: randomUUID(),
      executionId,
      expectedStateVersion: deliverClaim.execution.stateVersion + 1,
      externalResourceId: 'fake-invoice-1',
      externalResourceNumber: 'PI-0001',
      externalResourceType: 'purchaseInvoiceDraft',
      externalVersion: '1',
      operationId: delivery.id,
      tenantId,
    });

    await expect(
      executions.findById(tenantId, executionId),
    ).resolves.toMatchObject({
      currentStage: 'DELIVER',
      stateVersion: 7,
      status: 'SUCCEEDED',
    });
    await expect(
      pipeline.findDelivery(tenantId, executionId),
    ).resolves.toMatchObject({ status: 'APPLIED' });
  });
});
