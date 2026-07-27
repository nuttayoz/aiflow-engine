import { createHash, randomUUID } from 'node:crypto';
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
import {
  AesGcmSharePointCursorProtector,
  FakeSharePointGraphAdapter,
  SharePointIngestionProcessor,
  SharePointManagedEntryProvisioner,
  SharePointSyncProcessor,
} from '@aiflow/connector-microsoft-sharepoint';
import type { ValidatedWorkflowDefinition } from '@aiflow/workflows';
import type { ObjectStoragePort } from '@aiflow/storage';

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
import { PostgresSharePointRepository } from './sharepoint.repository';
import { PostgresSharePointProvisioningRepository } from './sharepoint-provisioning.repository';
import {
  PostgresSharePointIngestionRecoveryRepository,
  PostgresSharePointRecoveryRepository,
} from './sharepoint-recovery.repository';
import { PostgresSharePointIngestionRepository } from './sharepoint-ingestion.repository';
import { PostgresSharePointSyncRepository } from './sharepoint-sync.repository';
import { PostgresStorageObjectRepository } from './storage-object.repository';
import {
  PostgresWorkflowProvisioningRecoveryRepository,
  PostgresWorkflowProvisioningRepository,
} from './workflow-provisioning.repository';
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

  it('installs the additive Phase 4 SharePoint persistence boundary', async () => {
    const rows = (await runtimeDataSource.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'aiflow'
          AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [
        [
          'connector_provisioning_bindings',
          'document_ingestions',
          'sharepoint_binding_scopes',
          'sharepoint_drive_items',
          'sharepoint_drive_watches',
          'sharepoint_notification_events',
        ],
      ],
    )) as { table_name: string }[];

    expect(rows.map(({ table_name: tableName }) => tableName)).toEqual([
      'connector_provisioning_bindings',
      'document_ingestions',
      'sharepoint_binding_scopes',
      'sharepoint_drive_items',
      'sharepoint_drive_watches',
      'sharepoint_notification_events',
    ]);
    const constraints = (await runtimeDataSource.query(
      `
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'aiflow'
          AND constraint_name = ANY($1::text[])
        ORDER BY constraint_name
      `,
      [
        [
          'connector_provisioning_bindings_connection_fk',
          'document_ingestions_source_unique',
          'sharepoint_drive_watches_change_type_check',
          'sharepoint_notification_events_unique',
        ],
      ],
    )) as { constraint_name: string }[];
    expect(
      constraints.map(({ constraint_name: constraintName }) => constraintName),
    ).toEqual([
      'connector_provisioning_bindings_connection_fk',
      'document_ingestions_source_unique',
      'sharepoint_drive_watches_change_type_check',
      'sharepoint_notification_events_unique',
    ]);
    const forbiddenColumns = (await runtimeDataSource.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'aiflow'
          AND table_name LIKE 'sharepoint_%'
          AND column_name = ANY($1::text[])
      `,
      [
        [
          'access_token',
          'client_state',
          'committed_delta_cursor',
          'download_url',
          'raw_body',
        ],
      ],
    )) as { column_name: string }[];
    expect(forbiddenColumns).toEqual([]);
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
      provisioning.findCurrentByWorkflow(tenantId, workflowId),
    ).resolves.toMatchObject({ id: requested.id, status: 'PENDING' });
    await expect(
      provisioning.requestDeactivation({
        actor: { id: 'user-a', type: 'USER' },
        causationId: 'deactivate-during-activation',
        correlationId: 'correlation-a',
        idempotencyKey: 'deactivate-during-activation',
        operationId: randomUUID(),
        projectId,
        tenantId,
        workflowId,
      }),
    ).rejects.toThrow('WORKFLOW_PROVISIONING_IN_PROGRESS');
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
      provisioning.findCurrentByWorkflow(tenantId, workflowId),
    ).resolves.toBeUndefined();
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

  it('recovers an expired workflow provisioning lease durably', async () => {
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const provisioning = new PostgresWorkflowProvisioningRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const recovery = new PostgresWorkflowProvisioningRecoveryRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const tenantId = 'tenant-provisioning-recovery';
    const projectId = 'project-provisioning-recovery';
    const workflowId = randomUUID();
    const versionId = randomUUID();
    const operationId = randomUUID();
    await workflows.create({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'create-provisioning-recovery-workflow',
      correlationId: 'provisioning-recovery-correlation',
      definition: validatedDefinition,
      name: 'Provisioning recovery workflow',
      projectId,
      tenantId,
      versionId,
      workflowId,
    });
    const requested = await provisioning.requestActivation({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'activate-provisioning-recovery-workflow',
      correlationId: 'provisioning-recovery-correlation',
      idempotencyKey: 'activate-provisioning-recovery-workflow',
      operationId,
      projectId,
      targetVersionId: versionId,
      tenantId,
      workflowId,
    });
    await expect(
      provisioning.claim({
        consumerName: 'provisioning-worker',
        expectedStateVersion: requested.stateVersion,
        leaseDurationMs: 30_000,
        leaseOwner: 'crashed-provisioning-worker',
        messageId: 'crashed-provisioning-worker-message',
        messageType: 'aiflow.workflow.provisioning.requested.v1',
        operationId,
        projectId,
        tenantId,
      }),
    ).resolves.toMatchObject({ status: 'RUNNING' });
    await runtimeDataSource.query(
      `
        UPDATE aiflow.workflow_activation_operations
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, operationId],
    );

    await expect(recovery.recoverExpiredLeases(10)).resolves.toBe(1);
    await expect(
      provisioning.findById(tenantId, operationId),
    ).resolves.toMatchObject({
      stateVersion: 2,
      status: 'WAITING_RETRY',
    });
    const recoveryRows = (await runtimeDataSource.query(
      `
        SELECT
          operation.failure_category,
          operation.failure_code,
          COUNT(outbox.id)::integer AS outbox_count
        FROM aiflow.workflow_activation_operations AS operation
        LEFT JOIN aiflow.outbox_messages AS outbox
          ON outbox.tenant_id = operation.tenant_id
         AND outbox.aggregate_id = operation.id::text
         AND outbox.message_type = 'aiflow.workflow.provisioning.requested.v1'
        WHERE operation.tenant_id = $1
          AND operation.id = $2
        GROUP BY operation.failure_category, operation.failure_code
      `,
      [tenantId, operationId],
    )) as {
      failure_category: string;
      failure_code: string;
      outbox_count: number;
    }[];
    expect(recoveryRows).toEqual([
      {
        failure_category: 'TRANSIENT',
        failure_code: 'PROVISIONING_LEASE_EXPIRED',
        outbox_count: 2,
      },
    ]);
  });

  it('closes workflow intake immediately and replays deactivation idempotently', async () => {
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const provisioning = new PostgresWorkflowProvisioningRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const tenantId = 'tenant-deactivation';
    const projectId = 'project-deactivation';
    const workflowId = randomUUID();
    const versionId = randomUUID();
    await workflows.create({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'create-deactivation-workflow',
      correlationId: 'deactivation-correlation',
      definition: validatedDefinition,
      name: 'Deactivation workflow',
      projectId,
      tenantId,
      versionId,
      workflowId,
    });

    const operationId = randomUUID();
    const operation = await provisioning.requestActivation({
      actor: { id: 'user-a', type: 'USER' },
      causationId: 'activate-deactivation-workflow',
      correlationId: 'deactivation-correlation',
      idempotencyKey: 'activate-deactivation-workflow',
      operationId,
      projectId,
      targetVersionId: versionId,
      tenantId,
      workflowId,
    });
    const claimed = await provisioning.claim({
      consumerName: 'provisioning-worker',
      expectedStateVersion: operation.stateVersion,
      leaseDurationMs: 30_000,
      leaseOwner: 'deactivation-worker',
      messageId: 'deactivation-activation-message',
      messageType: 'aiflow.workflow.provisioning.requested.v1',
      operationId,
      projectId,
      tenantId,
    });
    if (claimed === undefined) {
      throw new Error('expected claimed activation');
    }
    await provisioning.completeActivation({
      expectedStateVersion: claimed.stateVersion,
      leaseOwner: 'deactivation-worker',
      operationId,
      tenantId,
    });
    await expect(
      workflows.archive({
        actor: { id: 'user-a', type: 'USER' },
        causationId: 'archive-active-workflow',
        correlationId: 'deactivation-correlation',
        idempotencyKey: 'archive-active-workflow',
        projectId,
        tenantId,
        workflowId,
      }),
    ).rejects.toThrow('WORKFLOW_ARCHIVE_NOT_ALLOWED');

    const deactivationInput = {
      actor: { id: 'user-a', type: 'USER' as const },
      causationId: 'deactivate-workflow',
      correlationId: 'deactivation-correlation',
      idempotencyKey: 'deactivate-workflow-once',
      operationId: randomUUID(),
      projectId,
      tenantId,
      workflowId,
    };
    const deactivated =
      await provisioning.requestDeactivation(deactivationInput);
    expect(deactivated).toEqual({
      acceptingNewDocuments: false,
      cleanupRequired: false,
      health: 'UNKNOWN',
      workflowId,
    });
    await expect(
      provisioning.requestDeactivation(deactivationInput),
    ).resolves.toEqual(deactivated);
    const stored = await workflows.findById(tenantId, workflowId);
    expect(stored).toMatchObject({
      acceptingNewDocuments: false,
      cleanupRequired: false,
      health: 'UNKNOWN',
      status: 'INACTIVE',
    });
    expect(stored?.activeVersionId).toBeUndefined();
    await expect(
      provisioning.requestDeactivation({
        ...deactivationInput,
        causationId: 'deactivate-workflow-again',
        idempotencyKey: 'deactivate-workflow-again',
        operationId: randomUUID(),
      }),
    ).resolves.toEqual(deactivated);

    const archiveInput = {
      actor: { id: 'user-a', type: 'USER' as const },
      causationId: 'archive-workflow',
      correlationId: 'deactivation-correlation',
      idempotencyKey: 'archive-workflow-once',
      projectId,
      tenantId,
      workflowId,
    };
    await expect(workflows.archive(archiveInput)).resolves.toMatchObject({
      id: workflowId,
      status: 'ARCHIVED',
    });
    await expect(workflows.archive(archiveInput)).resolves.toMatchObject({
      id: workflowId,
      status: 'ARCHIVED',
    });
    await expect(workflows.listByProject(tenantId, projectId)).resolves.toEqual(
      [],
    );
    await expect(
      workflows.listVersions(tenantId, workflowId),
    ).resolves.toHaveLength(1);
    await expect(
      workflows.createVersion({
        actor: { id: 'user-a', type: 'USER' },
        basedOnVersionId: versionId,
        causationId: 'edit-archived-workflow',
        correlationId: 'deactivation-correlation',
        definition: validatedDefinition,
        idempotencyKey: 'edit-archived-workflow',
        tenantId,
        versionId: randomUUID(),
        workflowId,
      }),
    ).rejects.toThrow('WORKFLOW_ARCHIVED');
    await expect(
      provisioning.requestActivation({
        actor: { id: 'user-a', type: 'USER' },
        causationId: 'activate-archived-workflow',
        correlationId: 'deactivation-correlation',
        idempotencyKey: 'activate-archived-workflow',
        operationId: randomUUID(),
        projectId,
        targetVersionId: versionId,
        tenantId,
        workflowId,
      }),
    ).rejects.toThrow('WORKFLOW_ARCHIVED');
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

  it('manages idempotent tenant-scoped connection metadata', async () => {
    const connections = new PostgresConnectionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const tenantId = 'connection-tenant';
    const connectionId = randomUUID();
    const createInput = {
      actor: { id: 'user-a', type: 'USER' as const },
      causationId: 'connection-create',
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'synthetic',
      correlationId: 'connection-correlation',
      displayName: 'Initial connection',
      id: connectionId,
      idempotencyKey: 'connection-create-once',
      tenantId,
    };

    await expect(connections.create(createInput)).resolves.toMatchObject({
      displayName: 'Initial connection',
      id: connectionId,
      stateVersion: 0,
      status: 'ACTIVE',
    });
    await expect(
      connections.create({ ...createInput, id: randomUUID() }),
    ).resolves.toMatchObject({ id: connectionId });
    await expect(
      connections.create({
        ...createInput,
        displayName: 'Conflicting replay',
        id: randomUUID(),
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    await expect(connections.list(tenantId, 'synthetic')).resolves.toHaveLength(
      1,
    );
    await expect(
      connections.list('different-tenant', 'synthetic'),
    ).resolves.toEqual([]);
    const healthInput = {
      actor: createInput.actor,
      causationId: 'connection-health',
      connectionId,
      correlationId: 'connection-correlation',
      health: 'HEALTHY' as const,
      tenantId,
    };
    await expect(connections.setHealth(healthInput)).resolves.toMatchObject({
      health: 'HEALTHY',
      stateVersion: 1,
    });
    await expect(connections.setHealth(healthInput)).resolves.toMatchObject({
      health: 'HEALTHY',
      stateVersion: 1,
    });

    const updateInput = {
      actor: createInput.actor,
      causationId: 'connection-update',
      connectionId,
      correlationId: 'connection-correlation',
      displayName: 'Renamed connection',
      expectedStateVersion: 1,
      idempotencyKey: 'connection-update-once',
      tenantId,
    };
    await expect(connections.update(updateInput)).resolves.toMatchObject({
      displayName: 'Renamed connection',
      stateVersion: 2,
    });
    await expect(connections.update(updateInput)).resolves.toMatchObject({
      displayName: 'Renamed connection',
      stateVersion: 2,
    });
    await expect(
      connections.update({
        ...updateInput,
        idempotencyKey: 'connection-update-stale',
      }),
    ).rejects.toThrow('CONNECTION_VERSION_CONFLICT');

    const revokeInput = {
      actor: createInput.actor,
      causationId: 'connection-revoke',
      connectionId,
      correlationId: 'connection-correlation',
      idempotencyKey: 'connection-revoke-once',
      tenantId,
    };
    await expect(connections.revoke(revokeInput)).resolves.toMatchObject({
      stateVersion: 3,
      status: 'REVOKED',
    });
    await expect(connections.revoke(revokeInput)).resolves.toMatchObject({
      stateVersion: 3,
      status: 'REVOKED',
    });
    await expect(connections.list(tenantId)).resolves.toEqual([]);
  });

  it('prevents connection revocation while immutable versions reference it', async () => {
    const connections = new PostgresConnectionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const tenantId = 'referenced-connection-tenant';
    const connectionId = randomUUID();
    const actor = { id: 'user-a', type: 'USER' as const };
    await connections.create({
      actor,
      causationId: 'referenced-connection-create',
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'synthetic',
      correlationId: 'referenced-connection-correlation',
      displayName: 'Referenced connection',
      id: connectionId,
      idempotencyKey: 'referenced-connection-create',
      tenantId,
    });
    await workflows.create({
      actor,
      causationId: 'referenced-workflow-create',
      correlationId: 'referenced-workflow-correlation',
      definition: {
        ...validatedDefinition,
        connectionReferences: [{ connectionId, purpose: 'DESTINATION' }],
        definition: {
          ...validatedDefinition.definition,
          destination: {
            ...validatedDefinition.definition.destination,
            connectionId,
          },
        },
      },
      name: 'Referenced connection workflow',
      projectId: 'project-a',
      tenantId,
      versionId: randomUUID(),
      workflowId: randomUUID(),
    });

    await expect(
      connections.revoke({
        actor,
        causationId: 'referenced-connection-revoke',
        connectionId,
        correlationId: 'referenced-connection-correlation',
        idempotencyKey: 'referenced-connection-revoke',
        tenantId,
      }),
    ).rejects.toThrow('CONNECTION_REFERENCE_CONFLICT');
  });

  it('provisions one shared SharePoint watch with an encrypted resumable baseline', async () => {
    const tenantId = `sharepoint-provision-${randomUUID()}`;
    const projectId = 'sharepoint-project';
    const connectionId = randomUUID();
    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    const operationId = randomUUID();
    const key = {
      keyVersion: 1,
      rootKey: new Uint8Array(32).fill(8),
    };
    const target = {
      connectionId,
      driveId: 'drive-provision-1',
      externalTenantId: 'external-tenant-provision-1',
      folderId: 'folder-provision-1',
      rootItemId: 'root-provision-1',
      siteId: 'site-provision-1',
    };

    const connections = new PostgresConnectionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    await connections.create({
      actor: { id: 'sharepoint-test', type: 'SYSTEM' },
      causationId: 'sharepoint-provision-connection',
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'microsoft-sharepoint',
      correlationId: 'sharepoint-provision-test',
      displayName: 'SharePoint provision connection',
      id: connectionId,
      idempotencyKey: `connection-${connectionId}`,
      tenantId,
    });
    await workflows.create({
      actor: { id: 'sharepoint-test', type: 'SYSTEM' },
      causationId: 'sharepoint-provision-workflow',
      correlationId: 'sharepoint-provision-test',
      definition: validatedDefinition,
      name: 'SharePoint provision workflow',
      projectId,
      tenantId,
      versionId: workflowVersionId,
      workflowId,
    });

    const graph = new FakeSharePointGraphAdapter(
      [target],
      () => new Date('2026-07-23T00:00:00.000Z'),
    );
    graph.setDeltaPage(connectionId, target.driveId, undefined, {
      finalCursor: 'confidential-final-delta-cursor',
      items: [
        {
          eTag: 'folder-etag',
          id: target.folderId,
          kind: 'FOLDER',
          name: 'Inbound',
          parentId: target.rootItemId,
        },
        {
          cTag: 'file-ctag',
          eTag: 'file-etag',
          id: 'baseline-file-1',
          kind: 'FILE',
          name: 'baseline.pdf',
          parentId: target.folderId,
          sizeBytes: 123,
        },
      ],
    });
    const cursorProtector = new AesGcmSharePointCursorProtector([key], 1);
    const repository = new PostgresSharePointProvisioningRepository(
      runtimeDataSource,
      runtimeConfig.schema,
      cursorProtector,
    );
    const provisioner = new SharePointManagedEntryProvisioner(
      repository,
      graph,
      [key],
      1,
      'http://localhost:3000/provider-callbacks/v1/microsoft-graph/sharepoint',
      () => new Date('2026-07-23T00:00:00.000Z'),
    );

    const operations = new PostgresWorkflowProvisioningRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    await operations.requestActivation({
      actor: { id: 'sharepoint-test', type: 'SYSTEM' },
      causationId: 'sharepoint-provision-activate',
      correlationId: 'sharepoint-provision-test',
      idempotencyKey: `activate-${operationId}`,
      operationId,
      projectId,
      targetVersionId: workflowVersionId,
      tenantId,
      workflowId,
    });
    const prepared = await provisioner.prepare({
      actionId: 'watch-folder',
      capabilityHash: 'f'.repeat(64),
      configuration: {
        driveId: target.driveId,
        folderId: target.folderId,
        includeSubfolders: true,
        siteId: target.siteId,
      },
      connectionId,
      operationId,
      projectId,
      tenantId,
      workflowId,
      workflowVersionId,
    });
    expect(prepared).toMatchObject({ status: 'READY' });
    if (prepared.status !== 'READY') throw new Error('TEST_SETUP_FAILED');
    const claimed = await operations.claim({
      consumerName: 'sharepoint-provision-worker',
      expectedStateVersion: 0,
      leaseDurationMs: 30_000,
      leaseOwner: 'sharepoint-provision-worker',
      messageId: randomUUID(),
      messageType: 'aiflow.workflow.provisioning.requested.v1',
      operationId,
      projectId,
      tenantId,
    });
    if (claimed === undefined) throw new Error('TEST_SETUP_FAILED');
    await operations.completeActivation({
      expectedStateVersion: claimed.stateVersion,
      leaseOwner: 'sharepoint-provision-worker',
      managedBindingId: prepared.bindingId,
      operationId,
      tenantId,
    });

    const [state] = (await runtimeDataSource.query(
      `
        SELECT
          binding.status AS binding_status,
          watch.baseline_status,
          watch.subscription_status,
          watch.committed_delta_cursor_ciphertext,
          workflow.status AS workflow_status,
          (
            SELECT count(*)::int
            FROM aiflow.sharepoint_drive_items AS item
            WHERE item.tenant_id = watch.tenant_id
              AND item.watch_id = watch.id
          ) AS item_count,
          (
            SELECT count(*)::int
            FROM aiflow.document_ingestions AS ingestion
            WHERE ingestion.tenant_id = watch.tenant_id
              AND ingestion.watch_id = watch.id
          ) AS ingestion_count
        FROM aiflow.connector_provisioning_bindings AS binding
        JOIN aiflow.sharepoint_binding_scopes AS scope
          ON scope.tenant_id = binding.tenant_id
         AND scope.binding_id = binding.id
        JOIN aiflow.sharepoint_drive_watches AS watch
          ON watch.tenant_id = scope.tenant_id
         AND watch.id = scope.watch_id
        JOIN aiflow.workflows AS workflow
          ON workflow.tenant_id = binding.tenant_id
         AND workflow.id = binding.workflow_id
        WHERE binding.tenant_id = $1
          AND binding.workflow_version_id = $2
      `,
      [tenantId, workflowVersionId],
    )) as {
      baseline_status: string;
      binding_status: string;
      committed_delta_cursor_ciphertext: Buffer;
      ingestion_count: number;
      item_count: number;
      subscription_status: string;
      workflow_status: string;
    }[];
    expect(state).toMatchObject({
      baseline_status: 'COMPLETE',
      binding_status: 'ACTIVE',
      ingestion_count: 0,
      item_count: 2,
      subscription_status: 'ACTIVE',
      workflow_status: 'ACTIVE',
    });
    expect(
      state?.committed_delta_cursor_ciphertext.includes(
        Buffer.from('confidential-final-delta-cursor'),
      ),
    ).toBe(false);
    expect(
      cursorProtector.unprotect(state!.committed_delta_cursor_ciphertext),
    ).toBe('confidential-final-delta-cursor');

    graph.setDeltaPage(
      connectionId,
      target.driveId,
      'confidential-final-delta-cursor',
      {
        finalCursor: 'confidential-next-delta-cursor',
        items: [
          {
            cTag: 'new-file-ctag',
            contentType: 'application/pdf',
            eTag: 'new-file-etag',
            id: 'new-file-1',
            kind: 'FILE',
            name: 'new-invoice.pdf',
            parentId: target.folderId,
            sizeBytes: 456,
          },
        ],
      },
    );
    const sync = new SharePointSyncProcessor(
      new PostgresSharePointSyncRepository(
        runtimeDataSource,
        runtimeConfig.schema,
        cursorProtector,
      ),
      graph,
      () => new Date('2026-07-23T00:01:00.000Z'),
    );
    const [watchIdentity] = (await runtimeDataSource.query(
      `
        SELECT watch.id
        FROM aiflow.sharepoint_drive_watches AS watch
        WHERE watch.tenant_id = $1 AND watch.drive_id = $2
      `,
      [tenantId, target.driveId],
    )) as { id: string }[];
    await expect(
      sync.process({
        consumerName: 'sharepoint-sync-worker',
        leaseDurationMs: 30_000,
        leaseOwner: 'sharepoint-sync-worker',
        messageId: randomUUID(),
        messageType:
          'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
        projectId,
        tenantId,
        watchId: watchIdentity!.id,
      }),
    ).resolves.toBe('PROCESSED');

    const [synced] = (await runtimeDataSource.query(
      `
        SELECT
          watch.committed_delta_cursor_ciphertext,
          watch.sync_command_pending,
          (
            SELECT count(*)::int
            FROM aiflow.document_ingestions AS ingestion
            WHERE ingestion.tenant_id = watch.tenant_id
              AND ingestion.watch_id = watch.id
          ) AS ingestion_count,
          (
            SELECT count(*)::int
            FROM aiflow.outbox_messages AS outbox
            WHERE outbox.tenant_id = watch.tenant_id
              AND outbox.aggregate_type = 'DOCUMENT_INGESTION'
          ) AS ingestion_outbox_count
        FROM aiflow.sharepoint_drive_watches AS watch
        WHERE watch.tenant_id = $1 AND watch.id = $2
      `,
      [tenantId, watchIdentity!.id],
    )) as {
      committed_delta_cursor_ciphertext: Buffer;
      ingestion_count: number;
      ingestion_outbox_count: number;
      sync_command_pending: boolean;
    }[];
    expect(synced).toMatchObject({
      ingestion_count: 1,
      ingestion_outbox_count: 1,
      sync_command_pending: false,
    });
    expect(
      cursorProtector.unprotect(synced!.committed_delta_cursor_ciphertext),
    ).toBe('confidential-next-delta-cursor');

    const fileContent = Buffer.alloc(456, 7);
    graph.setFileContent(
      connectionId,
      target.driveId,
      'new-file-1',
      fileContent,
    );
    const [ingestion] = (await runtimeDataSource.query(
      `
        SELECT id, state_version
        FROM aiflow.document_ingestions
        WHERE tenant_id = $1 AND watch_id = $2
      `,
      [tenantId, watchIdentity!.id],
    )) as { id: string; state_version: number | string }[];
    const objectStorage = {
      deleteExactVersion: jest.fn(),
      headCurrentVersion: jest.fn().mockResolvedValue(undefined),
      putImmutableStreaming: jest
        .fn()
        .mockImplementation(
          async (input: {
            contentLength: number;
            contentType: string;
            key: string;
            stream: AsyncIterable<Buffer | Uint8Array>;
          }) => {
            const chunks: Buffer[] = [];
            for await (const chunk of input.stream) {
              chunks.push(Buffer.from(chunk));
            }
            const uploaded = Buffer.concat(chunks);
            expect(uploaded).toEqual(fileContent);
            return {
              checksum: {
                algorithm: 'SHA256' as const,
                type: 'FULL_OBJECT' as const,
                value: createHash('sha256').update(uploaded).digest('base64'),
              },
              contentType: input.contentType,
              encryptionMode: 'AES256',
              key: input.key,
              sizeBytes: input.contentLength,
              versionId: 'fake-s3-version-1',
            };
          },
        ),
    } as unknown as ObjectStoragePort;
    await expect(
      new SharePointIngestionProcessor(
        new PostgresSharePointIngestionRepository(
          runtimeDataSource,
          runtimeConfig.schema,
        ),
        graph,
        objectStorage,
      ).process({
        consumerName: 'sharepoint-ingest-worker',
        expectedStateVersion: Number(ingestion!.state_version),
        ingestionId: ingestion!.id,
        leaseDurationMs: 30_000,
        leaseOwner: 'sharepoint-ingest-worker',
        messageId: randomUUID(),
        messageType:
          'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
        projectId,
        tenantId,
      }),
    ).resolves.toBe('PROCESSED');
    const [staged] = (await runtimeDataSource.query(
      `
        SELECT
          ingestion.status AS ingestion_status,
          storage.status AS storage_status,
          execution.status AS execution_status,
          document.source_connector_id,
          (
            SELECT count(*)::int
            FROM aiflow.outbox_messages AS outbox
            WHERE outbox.tenant_id = ingestion.tenant_id
              AND outbox.aggregate_type = 'EXECUTION'
              AND outbox.aggregate_id = execution.id::text
          ) AS extraction_outbox_count
        FROM aiflow.document_ingestions AS ingestion
        JOIN aiflow.storage_objects AS storage
          ON storage.tenant_id = ingestion.tenant_id
         AND storage.id = ingestion.storage_object_id
        JOIN aiflow.documents AS document
          ON document.tenant_id = ingestion.tenant_id
         AND document.id = ingestion.document_id
        JOIN aiflow.executions AS execution
          ON execution.tenant_id = ingestion.tenant_id
         AND execution.id = ingestion.execution_id
        WHERE ingestion.tenant_id = $1 AND ingestion.id = $2
      `,
      [tenantId, ingestion!.id],
    )) as {
      execution_status: string;
      extraction_outbox_count: number;
      ingestion_status: string;
      source_connector_id: string;
      storage_status: string;
    }[];
    expect(staged).toEqual({
      execution_status: 'QUEUED',
      extraction_outbox_count: 1,
      ingestion_status: 'SUCCEEDED',
      source_connector_id: 'microsoft-sharepoint',
      storage_status: 'AVAILABLE',
    });

    const recoveryIngestionId = randomUUID();
    const recoveryStorageObjectId = randomUUID();
    await runtimeDataSource.query(
      `
        INSERT INTO aiflow.storage_objects (
          id,
          tenant_id,
          project_id,
          kind,
          status,
          location_alias,
          object_key,
          retention_until
        ) VALUES (
          $1, $2, $3, 'SOURCE_DOCUMENT', 'RESERVED', 'PRIMARY', $4,
          clock_timestamp() + interval '30 days'
        )
      `,
      [
        recoveryStorageObjectId,
        tenantId,
        projectId,
        `recovery/${recoveryStorageObjectId}`,
      ],
    );
    await runtimeDataSource.query(
      `
        INSERT INTO aiflow.document_ingestions (
          id,
          tenant_id,
          project_id,
          connector_provisioning_binding_id,
          watch_id,
          workflow_id,
          workflow_version_id,
          connector_id,
          drive_id,
          item_id,
          source_version_kind,
          source_version,
          status,
          state_version,
          attempt_count,
          lease_owner,
          lease_expires_at,
          storage_object_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          'microsoft-sharepoint', $8, 'new-file-1', 'CTAG',
          'recovery-file-ctag', 'RUNNING', 1, 1,
          'expired-sharepoint-worker',
          clock_timestamp() - interval '1 second',
          $9
        )
      `,
      [
        recoveryIngestionId,
        tenantId,
        projectId,
        prepared.bindingId,
        watchIdentity!.id,
        workflowId,
        workflowVersionId,
        target.driveId,
        recoveryStorageObjectId,
      ],
    );
    await expect(
      new PostgresSharePointIngestionRecoveryRepository(
        runtimeDataSource,
        runtimeConfig.schema,
      ).recoverExpiredLeases(100),
    ).resolves.toBe(1);
    const [recovered] = (await runtimeDataSource.query(
      `
        SELECT
          ingestion.status AS ingestion_status,
          ingestion.failure_code,
          ingestion.storage_object_id,
          storage.status AS storage_status,
          (
            SELECT count(*)::int
            FROM aiflow.outbox_messages AS outbox
            WHERE outbox.tenant_id = ingestion.tenant_id
              AND outbox.aggregate_type = 'DOCUMENT_INGESTION'
              AND outbox.aggregate_id = ingestion.id::text
          ) AS retry_outbox_count
        FROM aiflow.document_ingestions AS ingestion
        JOIN aiflow.storage_objects AS storage
          ON storage.tenant_id = ingestion.tenant_id
         AND storage.id = $3
        WHERE ingestion.tenant_id = $1 AND ingestion.id = $2
      `,
      [tenantId, recoveryIngestionId, recoveryStorageObjectId],
    )) as {
      failure_code: string;
      ingestion_status: string;
      retry_outbox_count: number;
      storage_object_id: null | string;
      storage_status: string;
    }[];
    expect(recovered).toEqual({
      failure_code: 'SHAREPOINT_INGESTION_LEASE_EXPIRED',
      ingestion_status: 'WAITING_RETRY',
      retry_outbox_count: 1,
      storage_object_id: recoveryStorageObjectId,
      storage_status: 'RESERVED',
    });

    await runtimeDataSource.query(
      `
        UPDATE aiflow.sharepoint_drive_watches
        SET next_reconcile_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, watchIdentity!.id],
    );
    await expect(
      new PostgresSharePointRecoveryRepository(
        runtimeDataSource,
        runtimeConfig.schema,
      ).enqueueDueReconciliations(100),
    ).resolves.toBe(1);
    const [scheduled] = (await runtimeDataSource.query(
      `
        SELECT
          watch.sync_command_pending,
          (
            SELECT count(*)::int
            FROM aiflow.outbox_messages AS outbox
            WHERE outbox.tenant_id = watch.tenant_id
              AND outbox.aggregate_type = 'SHAREPOINT_DRIVE_WATCH'
              AND outbox.aggregate_id = watch.id::text
          ) AS sync_outbox_count
        FROM aiflow.sharepoint_drive_watches AS watch
        WHERE watch.tenant_id = $1 AND watch.id = $2
      `,
      [tenantId, watchIdentity!.id],
    )) as { sync_command_pending: boolean; sync_outbox_count: number }[];
    expect(scheduled).toEqual({
      sync_command_pending: true,
      sync_outbox_count: 1,
    });

    graph.setBehavior('CURSOR_INVALID');
    await expect(
      sync.process({
        consumerName: 'sharepoint-sync-worker',
        leaseDurationMs: 30_000,
        leaseOwner: 'sharepoint-sync-worker',
        messageId: randomUUID(),
        messageType:
          'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
        projectId,
        tenantId,
        watchId: watchIdentity!.id,
      }),
    ).resolves.toBe('DEFERRED');
    const [reset] = (await runtimeDataSource.query(
      `
        SELECT
          baseline_status,
          committed_delta_cursor_ciphertext,
          inventory_generation
        FROM aiflow.sharepoint_drive_watches
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, watchIdentity!.id],
    )) as {
      baseline_status: string;
      committed_delta_cursor_ciphertext: Buffer | null;
      inventory_generation: number | string;
    }[];
    expect(reset).toEqual({
      baseline_status: 'RECONCILING',
      committed_delta_cursor_ciphertext: null,
      inventory_generation: '2',
    });

    graph.setBehavior('NORMAL');
    graph.setDeltaPage(connectionId, target.driveId, undefined, {
      finalCursor: 'rebaseline-cursor',
      items: [
        {
          eTag: 'folder-etag',
          id: target.folderId,
          kind: 'FOLDER',
          name: 'Inbound',
          parentId: target.rootItemId,
        },
        {
          cTag: 'file-ctag',
          eTag: 'file-etag',
          id: 'baseline-file-1',
          kind: 'FILE',
          name: 'baseline.pdf',
          parentId: target.folderId,
          sizeBytes: 123,
        },
        {
          cTag: 'new-file-ctag',
          contentType: 'application/pdf',
          eTag: 'new-file-etag',
          id: 'new-file-1',
          kind: 'FILE',
          name: 'new-invoice.pdf',
          parentId: target.folderId,
          sizeBytes: 456,
        },
      ],
    });
    await expect(
      sync.process({
        consumerName: 'sharepoint-sync-worker',
        leaseDurationMs: 30_000,
        leaseOwner: 'sharepoint-sync-worker',
        messageId: randomUUID(),
        messageType:
          'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
        projectId,
        tenantId,
        watchId: watchIdentity!.id,
      }),
    ).resolves.toBe('PROCESSED');
    const [rebaselined] = (await runtimeDataSource.query(
      `
        SELECT
          baseline_status,
          committed_delta_cursor_ciphertext,
          (
            SELECT count(*)::int
            FROM aiflow.document_ingestions AS ingestion
            WHERE ingestion.tenant_id = watch.tenant_id
              AND ingestion.watch_id = watch.id
          ) AS ingestion_count
        FROM aiflow.sharepoint_drive_watches AS watch
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, watchIdentity!.id],
    )) as {
      baseline_status: string;
      committed_delta_cursor_ciphertext: Buffer;
      ingestion_count: number;
    }[];
    expect(rebaselined?.baseline_status).toBe('COMPLETE');
    expect(rebaselined?.ingestion_count).toBe(2);
    expect(
      cursorProtector.unprotect(rebaselined!.committed_delta_cursor_ciphertext),
    ).toBe('rebaseline-cursor');

    graph.setDeltaPage(connectionId, target.driveId, 'rebaseline-cursor', {
      finalCursor: 'after-folder-delete',
      items: [{ id: target.folderId, kind: 'DELETED' }],
    });
    await runtimeDataSource.query(
      `
        UPDATE aiflow.sharepoint_drive_watches
        SET sync_command_pending = true
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, watchIdentity!.id],
    );
    await expect(
      sync.process({
        consumerName: 'sharepoint-sync-worker',
        leaseDurationMs: 30_000,
        leaseOwner: 'sharepoint-sync-worker',
        messageId: randomUUID(),
        messageType:
          'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
        projectId,
        tenantId,
        watchId: watchIdentity!.id,
      }),
    ).resolves.toBe('PROCESSED');
    const [degraded] = (await runtimeDataSource.query(
      `
        SELECT
          binding.failure_code,
          binding.status AS binding_status,
          workflow.accepting_new_documents,
          workflow.health AS workflow_health
        FROM aiflow.connector_provisioning_bindings AS binding
        JOIN aiflow.workflows AS workflow
          ON workflow.tenant_id = binding.tenant_id
         AND workflow.id = binding.workflow_id
        WHERE binding.tenant_id = $1 AND binding.id = $2
      `,
      [tenantId, prepared.bindingId],
    )) as {
      accepting_new_documents: boolean;
      binding_status: string;
      failure_code: string;
      workflow_health: string;
    }[];
    expect(degraded).toEqual({
      accepting_new_documents: false,
      binding_status: 'FAILED',
      failure_code: 'SHAREPOINT_SELECTED_FOLDER_UNAVAILABLE',
      workflow_health: 'DEGRADED',
    });
  });

  it('deduplicates SharePoint callbacks and coalesces their durable wake-up', async () => {
    const tenantId = `sharepoint-tenant-${randomUUID()}`;
    const projectId = 'sharepoint-project';
    const connectionId = randomUUID();
    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    const bindingId = randomUUID();
    const watchId = randomUUID();
    const subscriptionId = `subscription-${randomUUID()}`;
    const clientStateDigest = 'c'.repeat(64);
    const resource = 'drives/drive-1/root';

    const connections = new PostgresConnectionRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const workflows = new PostgresWorkflowRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    await connections.create({
      actor: { id: 'sharepoint-test', type: 'SYSTEM' },
      causationId: 'sharepoint-connection',
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'microsoft-sharepoint',
      correlationId: 'sharepoint-callback-test',
      displayName: 'SharePoint test connection',
      id: connectionId,
      idempotencyKey: `connection-${connectionId}`,
      tenantId,
    });
    await workflows.create({
      actor: { id: 'sharepoint-test', type: 'SYSTEM' },
      causationId: 'sharepoint-workflow',
      correlationId: 'sharepoint-callback-test',
      definition: validatedDefinition,
      name: 'SharePoint callback workflow',
      projectId,
      tenantId,
      versionId: workflowVersionId,
      workflowId,
    });
    await runtimeDataSource.query(
      `
        INSERT INTO aiflow.connector_provisioning_bindings (
          id,
          tenant_id,
          project_id,
          workflow_id,
          workflow_version_id,
          connector_id,
          capability,
          capability_version,
          configuration_schema_version,
          connection_id,
          configuration_hash,
          capability_hash,
          provisioning_key,
          provider_resource_ref,
          status,
          health,
          accepting_new_documents
        ) VALUES (
          $1, $2, $3, $4, $5,
          'microsoft-sharepoint', 'ENTRY', 1, 1, $6,
          $7, $8, $9, $10, 'ACTIVE', 'HEALTHY', true
        )
      `,
      [
        bindingId,
        tenantId,
        projectId,
        workflowId,
        workflowVersionId,
        connectionId,
        'd'.repeat(64),
        'e'.repeat(64),
        randomUUID(),
        watchId,
      ],
    );
    await runtimeDataSource.query(
      `
        INSERT INTO aiflow.sharepoint_drive_watches (
          id,
          tenant_id,
          connection_id,
          external_tenant_id,
          site_id,
          drive_id,
          root_item_id,
          resource,
          change_type,
          subscription_id,
          subscription_expires_at,
          client_state_key_version,
          client_state_digest,
          baseline_status,
          subscription_status,
          health
        ) VALUES (
          $1, $2, $3, 'external-tenant-1', 'site-1', 'drive-1', 'root-1',
          $4, 'updated', $5, clock_timestamp() + interval '20 days',
          1, $6, 'COMPLETE', 'ACTIVE', 'HEALTHY'
        )
      `,
      [
        watchId,
        tenantId,
        connectionId,
        resource,
        subscriptionId,
        clientStateDigest,
      ],
    );
    await runtimeDataSource.query(
      `
        INSERT INTO aiflow.sharepoint_binding_scopes (
          tenant_id,
          binding_id,
          watch_id,
          site_id,
          drive_id,
          folder_id,
          include_subfolders,
          binding_generation
        ) VALUES ($1, $2, $3, 'site-1', 'drive-1', 'folder-1', true, 1)
      `,
      [tenantId, bindingId, watchId],
    );

    const sharePoint = new PostgresSharePointRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    const watch = await sharePoint.findWatchBySubscriptionId(subscriptionId);
    expect(watch).toMatchObject({
      externalTenantId: 'external-tenant-1',
      projectId,
      tenantId,
      watchId,
    });
    const notification = {
      bodySha256: 'a'.repeat(64),
      eventKeyHash: '1'.repeat(64),
      expectedClientStateDigest: clientStateDigest,
      expectedResource: resource,
      expectedSubscriptionId: subscriptionId,
      notificationKind: 'CHANGE' as const,
      projectId,
      receivedAt: new Date('2026-07-23T00:00:00.000Z'),
      tenantId,
      watchId,
    };
    await expect(
      sharePoint.recordVerifiedNotification(notification),
    ).resolves.toBe('ACCEPTED');
    await expect(
      sharePoint.recordVerifiedNotification(notification),
    ).resolves.toBe('DUPLICATE');
    await expect(
      sharePoint.recordVerifiedNotification({
        ...notification,
        eventKeyHash: '2'.repeat(64),
      }),
    ).resolves.toBe('ACCEPTED');

    const [state] = (await runtimeDataSource.query(
      `
        SELECT
          watch.notification_generation,
          watch.sync_command_pending,
          (
            SELECT count(*)::int
            FROM aiflow.sharepoint_notification_events
            WHERE tenant_id = $1 AND watch_id = $2
          ) AS event_count,
          (
            SELECT count(*)::int
            FROM aiflow.outbox_messages
            WHERE tenant_id = $1
              AND aggregate_type = 'SHAREPOINT_DRIVE_WATCH'
              AND aggregate_id = $2::text
          ) AS outbox_count
        FROM aiflow.sharepoint_drive_watches AS watch
        WHERE watch.tenant_id = $1 AND watch.id = $2
      `,
      [tenantId, watchId],
    )) as {
      event_count: number;
      notification_generation: number | string;
      outbox_count: number;
      sync_command_pending: boolean;
    }[];
    expect({
      ...state,
      notification_generation: Number(state?.notification_generation),
    }).toEqual({
      event_count: 2,
      notification_generation: 2,
      outbox_count: 1,
      sync_command_pending: true,
    });
    await runtimeDataSource.query(
      `
        UPDATE aiflow.sharepoint_notification_events
        SET expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND watch_id = $2 AND event_key_hash = $3
      `,
      [tenantId, watchId, notification.eventKeyHash],
    );
    const recovery = new PostgresSharePointRecoveryRepository(
      runtimeDataSource,
      runtimeConfig.schema,
    );
    await expect(recovery.purgeExpiredNotificationEvents(100)).resolves.toBe(1);
    const [retained] = (await runtimeDataSource.query(
      `
        SELECT count(*)::int AS count
        FROM aiflow.sharepoint_notification_events
        WHERE tenant_id = $1 AND watch_id = $2
      `,
      [tenantId, watchId],
    )) as { count: number }[];
    expect(retained?.count).toBe(1);
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
      actor: { id: 'user-b', type: 'USER' },
      causationId: 'cross-tenant-connection',
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'synthetic',
      correlationId: 'cross-tenant-connection',
      displayName: 'Tenant B destination',
      id: foreignConnectionId,
      idempotencyKey: 'cross-tenant-connection',
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
