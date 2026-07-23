import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';

import {
  loadDatabaseMigrationConfig,
  loadDatabaseRuntimeConfig,
  type DatabaseRuntimeConfig,
} from '@aiflow/config';
import type { ValidatedWorkflowDefinition } from '@aiflow/workflows';

import {
  createApplicationDataSource,
  createMigrationDataSource,
} from './data-source';
import { PostgresConnectionRepository } from './connection.repository';
import { PostgresDocumentRepository } from './document.repository';
import { PostgresExecutionRepository } from './execution.repository';
import { runDatabaseMigrations } from './migration-runner';
import { ENGINE_MIGRATIONS } from './migrations';
import { PostgresOutboxRepository } from './outbox.repository';
import {
  PostgresExecutionRecoveryRepository,
  PostgresSchedulerLeaseRepository,
} from './scheduler.repository';
import { PostgresStorageObjectRepository } from './storage-object.repository';
import { PostgresWorkflowProvisioningRepository } from './workflow-provisioning.repository';
import { PostgresWorkflowRepository } from './workflow.repository';

class DatabaseContractProbe1784592000001 implements MigrationInterface {
  readonly name = 'DatabaseContractProbe1784592000001';

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE aiflow.database_contract_probe');
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE aiflow.database_contract_probe (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        value text NOT NULL
      )
    `);
  }
}

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
    mappings: [
      {
        sourceField: 'value',
        targetField: 'value',
      },
    ],
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

describe('PostgreSQL foundation', () => {
  let container: StartedPostgreSqlContainer;
  let migrationConfig: DatabaseRuntimeConfig;
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
    migrationConfig = loadDatabaseMigrationConfig({
      DATABASE_MIGRATION_URL: connectionUrl(
        container,
        'aiflow_migration',
        'local-migration-only',
      ),
      NODE_ENV: 'test',
    });
    runtimeConfig = loadDatabaseRuntimeConfig({
      DATABASE_URL: connectionUrl(
        container,
        'aiflow_app',
        'local-application-only',
      ),
      DATABASE_POOL_MAX: '10',
      NODE_ENV: 'test',
    });
    await runDatabaseMigrations(migrationConfig, [
      ...ENGINE_MIGRATIONS,
      DatabaseContractProbe1784592000001,
    ]);
    runtimeDataSource = createApplicationDataSource(runtimeConfig, 'worker');
    await runtimeDataSource.initialize();
  });

  afterAll(async () => {
    if (runtimeDataSource?.isInitialized) {
      await runtimeDataSource.destroy();
    }
    await container?.stop();
  });

  it('runs reviewed migrations separately and grants runtime DML without DDL', async () => {
    await expect(
      runtimeDataSource.query(
        "INSERT INTO aiflow.database_contract_probe (value) VALUES ('ok') RETURNING value",
      ),
    ).resolves.toEqual([{ value: 'ok' }]);
    await expect(
      runtimeDataSource.query(
        "SELECT current_user AS user, current_schema() AS schema, has_schema_privilege(current_user, 'aiflow', 'CREATE') AS can_create",
      ),
    ).resolves.toEqual([
      { can_create: false, schema: 'aiflow', user: 'aiflow_app' },
    ]);
    await expect(
      runtimeDataSource.query('CREATE TABLE aiflow.forbidden (id integer)'),
    ).rejects.toThrow(/permission denied/u);

    const migrationDataSource = createMigrationDataSource(migrationConfig, [
      ...ENGINE_MIGRATIONS,
      DatabaseContractProbe1784592000001,
    ]);
    try {
      await migrationDataSource.initialize();
      await expect(
        migrationDataSource.undoLastMigration(),
      ).resolves.toBeUndefined();
      await expect(
        runDatabaseMigrations(migrationConfig, [
          ...ENGINE_MIGRATIONS,
          DatabaseContractProbe1784592000001,
        ]),
      ).resolves.toHaveLength(1);
    } finally {
      if (migrationDataSource.isInitialized) {
        await migrationDataSource.destroy();
      }
    }
  });

  it('keeps activation, execution, inbox, outbox, and leases durable and tenant-isolated', async () => {
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const provisioning = new PostgresWorkflowProvisioningRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const storage = new PostgresStorageObjectRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const documents = new PostgresDocumentRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const executions = new PostgresExecutionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const outbox = new PostgresOutboxRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const schedulerLeases = new PostgresSchedulerLeaseRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );

    const tenantId = 'tenant-a';
    const projectId = 'project-a';
    const workflowId = randomUUID();
    const versionId = randomUUID();
    await workflows.create({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'create-request',
      correlationId: 'correlation-a',
      definition: validatedDefinition,
      name: 'Synthetic workflow',
      projectId,
      tenantId,
      versionId,
      workflowId,
    });

    const firstOperationId = randomUUID();
    const activationInput = {
      actor: { id: 'user-a', type: 'USER' as const },
      causationId: 'activate-request',
      correlationId: 'correlation-a',
      idempotencyKey: 'activate-once',
      operationId: firstOperationId,
      projectId,
      targetVersionId: versionId,
      tenantId,
      workflowId,
    };
    const requested = await provisioning.requestActivation(activationInput);
    await expect(
      provisioning.requestActivation({
        ...activationInput,
        operationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ id: requested.id });
    await expect(
      provisioning.requestActivation({
        ...activationInput,
        operationId: randomUUID(),
        projectId: 'different-project',
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');

    const claimedOperation = await provisioning.claim({
      consumerName: 'provisioning-worker',
      expectedStateVersion: 0,
      leaseDurationMs: 30_000,
      leaseOwner: 'worker-a',
      messageId: 'provisioning-message-1',
      messageType: 'aiflow.workflow.provisioning.requested.v1',
      operationId: requested.id,
      projectId,
      tenantId,
    });
    expect(claimedOperation).toMatchObject({
      stateVersion: 1,
      status: 'RUNNING',
    });
    await provisioning.completeActivation({
      expectedStateVersion: 1,
      leaseOwner: 'worker-a',
      operationId: requested.id,
      tenantId,
    });
    await expect(
      workflows.findById(tenantId, workflowId),
    ).resolves.toMatchObject({
      acceptingNewDocuments: true,
      activeVersionId: versionId,
      status: 'ACTIVE',
    });

    const storageObjectId = randomUUID();
    const reserved = await storage.reserve({
      id: storageObjectId,
      kind: 'SOURCE_DOCUMENT',
      projectId,
      retentionUntil: new Date(Date.now() + 86_400_000),
      tenantId,
    });
    const available = await storage.markAvailable({
      expectedStateVersion: reserved.stateVersion,
      id: storageObjectId,
      metadata: {
        checksum: {
          algorithm: 'SHA256',
          type: 'FULL_OBJECT',
          value: Buffer.alloc(32, 1).toString('base64'),
        },
        contentType: 'application/pdf',
        encryptionMode: 'AES256',
        key: reserved.location.key,
        sizeBytes: 4,
        versionId: 'version-1',
      },
      tenantId,
    });
    const documentId = randomUUID();
    await documents.createStaged({
      id: documentId,
      originalFilename: 'synthetic.pdf',
      projectId,
      sourceConnectorId: 'direct-upload',
      sourceIdentity: 'upload-1',
      sourceStorageObjectId: available.id,
      sourceVersion: 'version-1',
      tenantId,
    });

    const executionId = randomUUID();
    const created = await executions.create({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'upload-complete',
      correlationId: 'correlation-a',
      documentId,
      executionId,
      projectId,
      reviewRequired: false,
      tenantId,
      workflowId,
      workflowVersionId: versionId,
    });
    expect(created).toMatchObject({ stateVersion: 0, status: 'QUEUED' });

    const competingClaims = await Promise.all([
      executions.claimStage({
        consumerName: 'extract-worker',
        executionId,
        expectedStateVersion: 0,
        leaseDurationMs: 30_000,
        leaseOwner: 'extract-a',
        messageId: 'extract-message-a',
        messageType: 'aiflow.execution.stage.extract.requested.v1',
        projectId,
        stage: 'EXTRACT',
        tenantId,
      }),
      executions.claimStage({
        consumerName: 'extract-worker',
        executionId,
        expectedStateVersion: 0,
        leaseDurationMs: 30_000,
        leaseOwner: 'extract-b',
        messageId: 'extract-message-b',
        messageType: 'aiflow.execution.stage.extract.requested.v1',
        projectId,
        stage: 'EXTRACT',
        tenantId,
      }),
    ]);
    const extractClaim = competingClaims.find((claim) => claim !== undefined);
    expect(competingClaims.filter((claim) => claim !== undefined)).toHaveLength(
      1,
    );
    if (extractClaim === undefined) {
      throw new Error('expected one extraction claim');
    }

    let execution = await executions.completeStage({
      causationId: 'extract-message-a',
      executionId,
      expectedStateVersion: extractClaim.execution.stateVersion,
      leaseOwner: extractClaim.attempt.leaseOwner,
      stage: 'EXTRACT',
      tenantId,
    });
    const mapClaim = await executions.claimStage({
      consumerName: 'map-worker',
      executionId,
      expectedStateVersion: execution.stateVersion,
      leaseDurationMs: 30_000,
      leaseOwner: 'map-a',
      messageId: 'map-message-a',
      messageType: 'aiflow.execution.stage.map.requested.v1',
      projectId,
      stage: 'MAP',
      tenantId,
    });
    if (mapClaim === undefined) {
      throw new Error('expected mapping claim');
    }
    execution = await executions.completeStage({
      causationId: 'map-message-a',
      executionId,
      expectedStateVersion: mapClaim.execution.stateVersion,
      leaseOwner: mapClaim.attempt.leaseOwner,
      stage: 'MAP',
      tenantId,
    });
    const deliveryClaim = await executions.claimStage({
      consumerName: 'delivery-worker',
      executionId,
      expectedStateVersion: execution.stateVersion,
      leaseDurationMs: 30_000,
      leaseOwner: 'delivery-a',
      messageId: 'delivery-message-a',
      messageType:
        'aiflow.execution.stage.deliver.connector.synthetic.requested.v1',
      projectId,
      stage: 'DELIVER',
      tenantId,
    });
    if (deliveryClaim === undefined) {
      throw new Error('expected delivery claim');
    }
    execution = await executions.completeStage({
      causationId: 'delivery-message-a',
      executionId,
      expectedStateVersion: deliveryClaim.execution.stateVersion,
      leaseOwner: deliveryClaim.attempt.leaseOwner,
      stage: 'DELIVER',
      tenantId,
    });
    expect(execution).toMatchObject({ stateVersion: 6, status: 'SUCCEEDED' });

    await expect(executions.findById('tenant-b', executionId)).resolves.toBe(
      undefined,
    );
    await expect(workflows.findById('tenant-b', workflowId)).resolves.toBe(
      undefined,
    );
    await expect(
      workflows.findVersionById('tenant-b', workflowId, versionId),
    ).resolves.toBeUndefined();
    await expect(
      provisioning.findById('tenant-b', requested.id),
    ).resolves.toBeUndefined();
    await expect(storage.findById('tenant-b', storageObjectId)).resolves.toBe(
      undefined,
    );
    await expect(documents.findById('tenant-b', documentId)).resolves.toBe(
      undefined,
    );

    const claimedBatches = await Promise.all([
      outbox.claim({ batchSize: 100, leaseDurationMs: 30_000, owner: 'pub-a' }),
      outbox.claim({ batchSize: 100, leaseDurationMs: 30_000, owner: 'pub-b' }),
    ]);
    const claimedIds = claimedBatches.flat().map(({ id }) => id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.length).toBeGreaterThanOrEqual(4);

    const competingLeases = await Promise.all([
      schedulerLeases.acquire({
        durationMs: 30_000,
        jobName: 'execution-recovery',
        owner: 'scheduler-a',
      }),
      schedulerLeases.acquire({
        durationMs: 30_000,
        jobName: 'execution-recovery',
        owner: 'scheduler-b',
      }),
    ]);
    expect(competingLeases.filter((lease) => lease !== undefined)).toHaveLength(
      1,
    );
    const leaseRows = (await runtimeDataSource.query(
      "SELECT lease_owner FROM aiflow.scheduler_leases WHERE job_name = 'execution-recovery'",
    )) as { lease_owner: string }[];
    expect(leaseRows).toHaveLength(1);
  });

  it('recovers an expired worker lease through durable retry scheduling', async () => {
    const executions = new PostgresExecutionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const recovery = new PostgresExecutionRecoveryRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const fixtures = (await runtimeDataSource.query(
      `
        SELECT
          workflow.tenant_id,
          workflow.project_id,
          workflow.id AS workflow_id,
          workflow.active_version_id AS workflow_version_id,
          document.id AS document_id
        FROM aiflow.workflows AS workflow
        JOIN aiflow.documents AS document
          ON document.tenant_id = workflow.tenant_id
         AND document.project_id = workflow.project_id
        WHERE workflow.status = 'ACTIVE'
        LIMIT 1
      `,
    )) as {
      document_id: string;
      project_id: string;
      tenant_id: string;
      workflow_id: string;
      workflow_version_id: string;
    }[];
    const fixture = fixtures[0];
    if (fixture === undefined) {
      throw new Error('expected durable execution fixture');
    }
    const executionId = randomUUID();
    await executions.create({
      actor: { id: 'system', type: 'SYSTEM' },
      causationId: 'recovery-test',
      correlationId: 'recovery-test',
      documentId: fixture.document_id,
      executionId,
      projectId: fixture.project_id,
      reviewRequired: false,
      tenantId: fixture.tenant_id,
      workflowId: fixture.workflow_id,
      workflowVersionId: fixture.workflow_version_id,
    });
    const claim = await executions.claimStage({
      consumerName: 'extract-worker',
      executionId,
      expectedStateVersion: 0,
      leaseDurationMs: 30_000,
      leaseOwner: 'crashed-worker',
      messageId: 'crashed-worker-message',
      messageType: 'aiflow.execution.stage.extract.requested.v1',
      projectId: fixture.project_id,
      stage: 'EXTRACT',
      tenantId: fixture.tenant_id,
    });
    expect(claim).toBeDefined();
    await runtimeDataSource.query(
      `
        UPDATE aiflow.execution_stages
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND execution_id = $2 AND status = 'RUNNING'
      `,
      [fixture.tenant_id, executionId],
    );
    await expect(recovery.recoverExpiredLeases(10, 1_000)).resolves.toEqual({
      processed: 1,
    });
    await runtimeDataSource.query(
      `
        UPDATE aiflow.execution_stages
        SET next_attempt_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND execution_id = $2 AND status = 'RETRY_SCHEDULED'
      `,
      [fixture.tenant_id, executionId],
    );
    await expect(recovery.enqueueDueRetries(10)).resolves.toEqual({
      processed: 1,
    });
    await expect(
      executions.findById(fixture.tenant_id, executionId),
    ).resolves.toMatchObject({
      stateVersion: 3,
      stages: { EXTRACT: { status: 'PENDING' } },
    });
  });

  it('creates immutable workflow versions idempotently with optimistic edit context', async () => {
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const tenantId = 'tenant-workflow-version';
    const workflowId = randomUUID();
    const firstVersionId = randomUUID();
    await workflows.create({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'create-versioned-workflow',
      correlationId: 'version-correlation',
      definition: validatedDefinition,
      name: 'Versioned workflow',
      projectId: 'project-a',
      tenantId,
      versionId: firstVersionId,
      workflowId,
    });

    const revisedDefinition: ValidatedWorkflowDefinition = {
      ...validatedDefinition,
      definition: {
        ...validatedDefinition.definition,
        mappings: [
          {
            required: true,
            sourceField: 'value',
            targetField: 'value',
          },
        ],
      },
      definitionHash: 'c'.repeat(64),
    };
    const secondVersionId = randomUUID();
    const createInput = {
      actor: { id: 'user-a', type: 'USER' as const },
      basedOnVersionId: firstVersionId,
      causationId: 'edit-versioned-workflow',
      correlationId: 'version-correlation',
      definition: revisedDefinition,
      idempotencyKey: 'edit-versioned-workflow-once',
      tenantId,
      versionId: secondVersionId,
      workflowId,
    };
    await expect(workflows.createVersion(createInput)).resolves.toMatchObject({
      id: secondVersionId,
      versionNumber: 2,
      workflowId,
    });
    await expect(
      workflows.createVersion({ ...createInput, versionId: randomUUID() }),
    ).resolves.toMatchObject({ id: secondVersionId, versionNumber: 2 });
    await expect(workflows.listVersions(tenantId, workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstVersionId, versionNumber: 1 }),
        expect.objectContaining({ id: secondVersionId, versionNumber: 2 }),
      ]),
    );
    await expect(
      workflows.createVersion({
        ...createInput,
        idempotencyKey: 'stale-edit',
        versionId: randomUUID(),
      }),
    ).rejects.toThrow('WORKFLOW_VERSION_CONFLICT');
    await expect(
      workflows.createVersion({
        ...createInput,
        definition: validatedDefinition,
        versionId: randomUUID(),
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    await expect(
      workflows.listVersions('different-tenant', workflowId),
    ).resolves.toEqual([]);
  });

  it('enforces tenant ownership in composite foreign keys', async () => {
    const connections = new PostgresConnectionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const foreignConnectionId = randomUUID();
    await connections.create({
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'synthetic',
      displayName: 'Tenant B destination',
      id: foreignConnectionId,
      tenantId: 'tenant-b',
    });
    await expect(
      connections.findById('tenant-a', foreignConnectionId),
    ).resolves.toBeUndefined();

    await expect(
      workflows.create({
        actor: { id: 'user-a', type: 'USER' },
        causationId: 'cross-tenant-test',
        correlationId: 'cross-tenant-test',
        definition: {
          ...validatedDefinition,
          connectionReferences: [
            { connectionId: foreignConnectionId, purpose: 'DESTINATION' },
          ],
        },
        name: 'Invalid cross-tenant workflow',
        projectId: 'project-a',
        tenantId: 'tenant-a',
        versionId: randomUUID(),
        workflowId: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});
