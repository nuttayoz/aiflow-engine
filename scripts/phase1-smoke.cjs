#!/usr/bin/env node

const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

const {
  loadDatabaseRuntimeConfig,
  loadS3RuntimeConfig,
} = require('../packages/config/dist');
const {
  directUploadConnector,
} = require('../packages/connectors/direct-upload/dist');
const {
  phase1SyntheticConnector,
} = require('../packages/connectors/phase1-synthetic/dist');
const { ConnectorRegistry } = require('../packages/connector-sdk/dist');
const {
  createApplicationDataSource,
  PostgresDocumentRepository,
  PostgresExecutionRepository,
  PostgresStorageObjectRepository,
  PostgresWorkflowProvisioningRepository,
  PostgresWorkflowRepository,
} = require('../packages/database/dist');
const {
  InMemoryExtractionProfileCatalog,
} = require('../packages/extraction/dist');
const {
  buildStorageObjectKey,
  S3ObjectStorage,
} = require('../packages/storage/dist');
const { WorkflowDefinitionValidator } = require('../packages/workflows/dist');

const waitFor = async (description, load, complete) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await load();
    if (complete(value)) {
      return value;
    }
    await delay(250);
  }
  throw new Error(`PHASE1_SMOKE_TIMEOUT:${description}`);
};

const run = async () => {
  const databaseConfig = loadDatabaseRuntimeConfig();
  const s3Config = loadS3RuntimeConfig();
  const dataSource = createApplicationDataSource(databaseConfig, 'api');
  const storage = new S3ObjectStorage(s3Config);

  await dataSource.initialize();
  try {
    const tenantId = `phase1-smoke-${randomUUID()}`;
    const projectId = randomUUID();
    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    const operationId = randomUUID();
    const documentId = randomUUID();
    const executionId = randomUUID();
    const storageObjectId = randomUUID();
    const correlationId = randomUUID();
    const actor = { id: 'phase1-smoke', type: 'SYSTEM' };
    const schema = databaseConfig.schema;

    const workflowRepository = new PostgresWorkflowRepository(
      dataSource,
      schema,
    );
    const provisioningRepository = new PostgresWorkflowProvisioningRepository(
      dataSource,
      schema,
    );
    const storageRepository = new PostgresStorageObjectRepository(
      dataSource,
      schema,
    );
    const documentRepository = new PostgresDocumentRepository(
      dataSource,
      schema,
    );
    const executionRepository = new PostgresExecutionRepository(
      dataSource,
      schema,
    );

    const registry = new ConnectorRegistry([
      directUploadConnector,
      phase1SyntheticConnector,
    ]);
    const validator = new WorkflowDefinitionValidator(
      registry,
      new InMemoryExtractionProfileCatalog([
        {
          outputFields: ['invoiceNumber'],
          outputSchemaHash: createHash('sha256')
            .update('phase1-profile-schema')
            .digest('hex'),
          profileId: 'phase1-profile',
          profileKind: 'SYSTEM',
          profileVersionId: 'phase1-profile-v1',
        },
      ]),
    );
    const validation = validator.validate({
      destination: {
        actionId: 'accept',
        config: {},
        connectorId: 'phase1-synthetic',
      },
      entry: { config: {}, connectorId: 'direct-upload' },
      extraction: { config: {}, profileId: 'phase1-profile' },
      mappings: [
        {
          required: true,
          sourceField: 'invoiceNumber',
          targetField: 'invoiceNumber',
        },
      ],
      reviewPolicy: { required: false },
      schemaVersion: 1,
    });
    if (!validation.valid) {
      throw new Error('PHASE1_WORKFLOW_INVALID');
    }

    await workflowRepository.create({
      actor,
      causationId: correlationId,
      correlationId,
      definition: validation.value,
      name: 'Phase 1 reliability smoke',
      projectId,
      tenantId,
      versionId: workflowVersionId,
      workflowId,
    });
    await provisioningRepository.requestActivation({
      actor,
      causationId: correlationId,
      correlationId,
      idempotencyKey: `phase1-smoke:${workflowId}`,
      operationId,
      projectId,
      targetVersionId: workflowVersionId,
      tenantId,
      workflowId,
    });
    await waitFor(
      'activation',
      () => provisioningRepository.findById(tenantId, operationId),
      (operation) => operation?.status === 'SUCCEEDED',
    );

    const body = Buffer.from('phase-one-synthetic-source');
    const checksumValue = createHash('sha256').update(body).digest('base64');
    const reserved = await storageRepository.reserve({
      id: storageObjectId,
      kind: 'SOURCE_DOCUMENT',
      projectId,
      retentionUntil: new Date(Date.now() + 86_400_000),
      tenantId,
    });
    const metadata = await storage.putImmutable({
      checksum: {
        algorithm: 'SHA256',
        type: 'FULL_OBJECT',
        value: checksumValue,
      },
      contentLength: body.length,
      contentType: 'application/pdf',
      key: buildStorageObjectKey(tenantId, storageObjectId),
      stream: Readable.from(body),
    });
    await storageRepository.markAvailable({
      expectedStateVersion: reserved.stateVersion,
      id: storageObjectId,
      metadata,
      tenantId,
    });
    await documentRepository.createStaged({
      id: documentId,
      originalFilename: 'phase1-smoke.pdf',
      projectId,
      sourceConnectorId: 'direct-upload',
      sourceIdentity: `phase1-smoke:${documentId}`,
      sourceStorageObjectId: storageObjectId,
      sourceVersion: metadata.versionId,
      tenantId,
    });
    await executionRepository.create({
      actor,
      causationId: correlationId,
      correlationId,
      documentId,
      executionId,
      projectId,
      reviewRequired: false,
      tenantId,
      workflowId,
      workflowVersionId,
    });

    const execution = await waitFor(
      'execution',
      () => executionRepository.findById(tenantId, executionId),
      (candidate) => candidate?.status === 'SUCCEEDED',
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          executionId,
          stages: Object.fromEntries(
            Object.entries(execution.stages).map(([stage, state]) => [
              stage,
              state.status,
            ]),
          ),
          status: execution.status,
          tenantId,
          workflowId,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    storage.close();
    await dataSource.destroy();
  }
};

void run().catch((error) => {
  const code = error instanceof Error ? error.message : 'PHASE1_SMOKE_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
