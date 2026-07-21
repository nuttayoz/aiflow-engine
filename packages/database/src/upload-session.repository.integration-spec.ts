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
import type { CreateUploadSessionInput } from '@aiflow/storage';
import type { ValidatedWorkflowDefinition } from '@aiflow/workflows';

import { createApplicationDataSource } from './data-source';
import { runDatabaseMigrations } from './migration-runner';
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
      definition: validatedDefinition,
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
});
