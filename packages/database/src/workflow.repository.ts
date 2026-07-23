import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import type {
  ArchiveWorkflowInput,
  CreateWorkflowInput,
  CreateWorkflowVersionInput,
  ValidatedWorkflowDefinition,
  WorkflowRecord,
  WorkflowRepository,
  WorkflowVersionRecord,
} from '@aiflow/workflows';

import { table } from './sql';

interface WorkflowRow {
  accepting_new_documents: boolean;
  active_version_id: string | null;
  cleanup_required: boolean;
  created_at: Date | string;
  health: WorkflowRecord['health'];
  id: string;
  name: string;
  project_id: string;
  state_version: number | string;
  status: WorkflowRecord['status'];
  tenant_id: string;
  updated_at: Date | string;
}

interface WorkflowVersionRow {
  correlation_id: string;
  created_at: Date | string;
  created_by_actor_id: string;
  created_by_actor_type: WorkflowVersionRecord['createdBy']['type'];
  definition: ValidatedWorkflowDefinition['definition'] | string;
  definition_hash: string;
  id: string;
  output_schema_hash: string;
  profile_id: string;
  profile_kind: 'CUSTOM' | 'SYSTEM';
  profile_version_id: string;
  tenant_id: string;
  version_number: number | string;
  workflow_id: string;
}

interface ConnectionReferenceRow {
  connection_id: string;
  purpose: 'DESTINATION' | 'ENTRY';
}

interface WorkflowIdentityRow {
  project_id: string;
  status: WorkflowRecord['status'];
}

interface WorkflowArchiveRow {
  accepting_new_documents: boolean;
  active_version_id: string | null;
  cleanup_required: boolean;
  project_id: string;
  status: WorkflowRecord['status'];
}

const mapWorkflow = (row: WorkflowRow): WorkflowRecord => ({
  acceptingNewDocuments: row.accepting_new_documents,
  ...(row.active_version_id === null
    ? {}
    : { activeVersionId: row.active_version_id }),
  cleanupRequired: row.cleanup_required,
  createdAt: new Date(row.created_at),
  health: row.health,
  id: row.id,
  name: row.name,
  projectId: row.project_id,
  stateVersion: Number(row.state_version),
  status: row.status,
  tenantId: row.tenant_id,
  updatedAt: new Date(row.updated_at),
});

export class PostgresWorkflowRepository implements WorkflowRepository {
  private readonly auditEvents: string;
  private readonly connectionReferences: string;
  private readonly idempotency: string;
  private readonly operations: string;
  private readonly profileReferences: string;
  private readonly versions: string;
  private readonly workflows: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.auditEvents = table(schema, 'audit_events');
    this.connectionReferences = table(
      schema,
      'workflow_version_connection_refs',
    );
    this.idempotency = table(schema, 'idempotency_records');
    this.operations = table(schema, 'workflow_activation_operations');
    this.profileReferences = table(schema, 'workflow_version_profile_refs');
    this.versions = table(schema, 'workflow_versions');
    this.workflows = table(schema, 'workflows');
  }

  async archive(input: ArchiveWorkflowInput): Promise<WorkflowRecord> {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          projectId: input.projectId,
          workflowId: input.workflowId,
        }),
      )
      .digest('hex');

    await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT
            project_id,
            status,
            active_version_id,
            accepting_new_documents,
            cleanup_required
          FROM ${this.workflows}
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          FOR UPDATE
        `,
        [input.tenantId, input.projectId, input.workflowId],
      )) as WorkflowArchiveRow[];
      const workflow = rows[0];
      if (workflow === undefined) {
        throw new Error('WORKFLOW_NOT_FOUND');
      }

      const existing = (await manager.query(
        `
          SELECT request_fingerprint, resource_id
          FROM ${this.idempotency}
          WHERE tenant_id = $1
            AND operation_scope = 'workflow.archive'
            AND idempotency_key = $2
          FOR UPDATE
        `,
        [input.tenantId, input.idempotencyKey],
      )) as { request_fingerprint: string; resource_id: string | null }[];
      if (existing[0] !== undefined) {
        if (existing[0].request_fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        if (existing[0].resource_id !== input.workflowId) {
          throw new Error('WORKFLOW_ARCHIVE_IDEMPOTENCY_INCONSISTENT');
        }
        return;
      }

      const current = (await manager.query(
        `
          SELECT id
          FROM ${this.operations}
          WHERE tenant_id = $1
            AND workflow_id = $2
            AND status IN ('PENDING', 'RUNNING', 'WAITING_RETRY', 'RECONCILING')
          LIMIT 1
          FOR UPDATE
        `,
        [input.tenantId, input.workflowId],
      )) as { id: string }[];
      if (current.length > 0) {
        throw new Error('WORKFLOW_PROVISIONING_IN_PROGRESS');
      }
      if (
        workflow.status === 'ACTIVE' ||
        workflow.active_version_id !== null ||
        workflow.accepting_new_documents ||
        workflow.cleanup_required
      ) {
        throw new Error('WORKFLOW_ARCHIVE_NOT_ALLOWED');
      }

      const inserted = (await manager.query(
        `
          INSERT INTO ${this.idempotency} (
            id,
            tenant_id,
            operation_scope,
            idempotency_key,
            request_fingerprint,
            status,
            resource_type,
            resource_id,
            completed_at,
            expires_at
          ) VALUES (
            $1, $2, 'workflow.archive', $3, $4, 'COMPLETED',
            'WORKFLOW', $5, clock_timestamp(), clock_timestamp() + interval '90 days'
          )
          ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
          RETURNING id
        `,
        [
          randomUUID(),
          input.tenantId,
          input.idempotencyKey,
          fingerprint,
          input.workflowId,
        ],
      )) as { id: string }[];
      if (inserted.length === 0) {
        const concurrent = (await manager.query(
          `
            SELECT request_fingerprint, resource_id
            FROM ${this.idempotency}
            WHERE tenant_id = $1
              AND operation_scope = 'workflow.archive'
              AND idempotency_key = $2
            FOR UPDATE
          `,
          [input.tenantId, input.idempotencyKey],
        )) as { request_fingerprint: string; resource_id: string | null }[];
        if (concurrent[0]?.request_fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        if (concurrent[0]?.resource_id !== input.workflowId) {
          throw new Error('WORKFLOW_ARCHIVE_IDEMPOTENCY_INCONSISTENT');
        }
        return;
      }

      const changed = workflow.status !== 'ARCHIVED';
      if (changed) {
        await manager.query(
          `
            UPDATE ${this.workflows}
            SET status = 'ARCHIVED',
                archived_at = clock_timestamp(),
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          `,
          [input.tenantId, input.projectId, input.workflowId],
        );
      }
      await this.appendArchiveAudit(manager, input, changed);
    });

    const workflow = await this.findById(input.tenantId, input.workflowId);
    if (workflow === undefined) {
      throw new Error('WORKFLOW_ARCHIVE_INCONSISTENT');
    }
    return workflow;
  }

  async create(input: CreateWorkflowInput): Promise<{
    readonly version: WorkflowVersionRecord;
    readonly workflow: WorkflowRecord;
  }> {
    if (input.name.trim().length === 0 || input.name.length > 180) {
      throw new Error('WORKFLOW_NAME_INVALID');
    }

    const created = await this.dataSource.transaction(async (manager) => {
      if (input.idempotencyKey !== undefined) {
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify({
              definitionHash: input.definition.definitionHash,
              name: input.name.trim(),
              projectId: input.projectId,
            }),
          )
          .digest('hex');
        const inserted = (await manager.query(
          `
            INSERT INTO ${this.idempotency} (
              id, tenant_id, operation_scope, idempotency_key,
              request_fingerprint, status, resource_type, resource_id,
              completed_at, expires_at
            ) VALUES (
              $1, $2, 'workflow.create', $3, $4, 'COMPLETED',
              'WORKFLOW', $5, clock_timestamp(), clock_timestamp() + interval '90 days'
            )
            ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
            RETURNING id
          `,
          [
            randomUUID(),
            input.tenantId,
            input.idempotencyKey,
            fingerprint,
            input.workflowId,
          ],
        )) as { id: string }[];
        if (inserted.length === 0) {
          const rows = (await manager.query(
            `
              SELECT request_fingerprint, resource_id
              FROM ${this.idempotency}
              WHERE tenant_id = $1
                AND operation_scope = 'workflow.create'
                AND idempotency_key = $2
              FOR UPDATE
            `,
            [input.tenantId, input.idempotencyKey],
          )) as { request_fingerprint: string; resource_id: string | null }[];
          if (rows[0]?.request_fingerprint !== fingerprint) {
            throw new Error('IDEMPOTENCY_KEY_REUSED');
          }
          if (rows[0]?.resource_id !== input.workflowId) {
            throw new Error('IDEMPOTENCY_RESOURCE_CONFLICT');
          }
          return false;
        }
      }
      await manager.query(
        `
          INSERT INTO ${this.workflows} (
            id, tenant_id, project_id, name
          ) VALUES ($1, $2, $3, $4)
        `,
        [input.workflowId, input.tenantId, input.projectId, input.name.trim()],
      );
      await manager.query(
        `
          INSERT INTO ${this.versions} (
            id,
            tenant_id,
            workflow_id,
            version_number,
            definition_schema_version,
            definition,
            definition_hash,
            created_by_actor_type,
            created_by_actor_id,
            correlation_id
          ) VALUES ($1, $2, $3, 1, 1, $4::jsonb, $5, $6, $7, $8)
        `,
        [
          input.versionId,
          input.tenantId,
          input.workflowId,
          JSON.stringify(input.definition.definition),
          input.definition.definitionHash,
          input.actor.type,
          input.actor.id,
          input.correlationId,
        ],
      );

      await this.insertDefinitionReferences(
        manager,
        input.tenantId,
        input.versionId,
        input.definition,
      );
      await this.appendAudit(manager, input);
      return true;
    });

    const workflow = await this.findById(input.tenantId, input.workflowId);
    const version = await this.findVersionById(
      input.tenantId,
      input.workflowId,
      input.versionId,
    );
    if (workflow === undefined || version === undefined) {
      throw new Error(
        created
          ? 'WORKFLOW_CREATE_INCONSISTENT'
          : 'WORKFLOW_IDEMPOTENCY_INCONSISTENT',
      );
    }

    return { version, workflow };
  }

  async createVersion(
    input: CreateWorkflowVersionInput,
  ): Promise<WorkflowVersionRecord> {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          basedOnVersionId: input.basedOnVersionId,
          definitionHash: input.definition.definitionHash,
          workflowId: input.workflowId,
        }),
      )
      .digest('hex');

    const versionId = await this.dataSource.transaction(async (manager) => {
      const workflows = (await manager.query(
        `
          SELECT project_id, status
          FROM ${this.workflows}
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE
        `,
        [input.tenantId, input.workflowId],
      )) as WorkflowIdentityRow[];
      const workflow = workflows[0];
      if (workflow === undefined) {
        throw new Error('WORKFLOW_NOT_FOUND');
      }

      const inserted = (await manager.query(
        `
          INSERT INTO ${this.idempotency} (
            id, tenant_id, operation_scope, idempotency_key,
            request_fingerprint, status, resource_type, resource_id,
            completed_at, expires_at
          ) VALUES (
            $1, $2, 'workflow.version.create', $3, $4, 'COMPLETED',
            'WORKFLOW_VERSION', $5, clock_timestamp(), clock_timestamp() + interval '90 days'
          )
          ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
          RETURNING id
        `,
        [
          randomUUID(),
          input.tenantId,
          input.idempotencyKey,
          fingerprint,
          input.versionId,
        ],
      )) as { id: string }[];
      if (inserted.length === 0) {
        const rows = (await manager.query(
          `
            SELECT request_fingerprint, resource_id
            FROM ${this.idempotency}
            WHERE tenant_id = $1
              AND operation_scope = 'workflow.version.create'
              AND idempotency_key = $2
            FOR UPDATE
          `,
          [input.tenantId, input.idempotencyKey],
        )) as { request_fingerprint: string; resource_id: string | null }[];
        if (rows[0]?.request_fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        if (rows[0]?.resource_id === null || rows[0] === undefined) {
          throw new Error('WORKFLOW_VERSION_IDEMPOTENCY_INCONSISTENT');
        }
        return rows[0].resource_id;
      }

      if (workflow.status === 'ARCHIVED') {
        throw new Error('WORKFLOW_ARCHIVED');
      }

      const latestRows = (await manager.query(
        `
          SELECT id, version_number
          FROM ${this.versions}
          WHERE tenant_id = $1 AND workflow_id = $2
          ORDER BY version_number DESC
          LIMIT 1
        `,
        [input.tenantId, input.workflowId],
      )) as { id: string; version_number: number | string }[];
      const latest = latestRows[0];
      if (latest === undefined) {
        throw new Error('WORKFLOW_VERSION_NOT_FOUND');
      }
      if (latest.id !== input.basedOnVersionId) {
        throw new Error('WORKFLOW_VERSION_CONFLICT');
      }

      await manager.query(
        `
          INSERT INTO ${this.versions} (
            id,
            tenant_id,
            workflow_id,
            version_number,
            definition_schema_version,
            definition,
            definition_hash,
            created_by_actor_type,
            created_by_actor_id,
            correlation_id
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
        `,
        [
          input.versionId,
          input.tenantId,
          input.workflowId,
          Number(latest.version_number) + 1,
          input.definition.definition.schemaVersion,
          JSON.stringify(input.definition.definition),
          input.definition.definitionHash,
          input.actor.type,
          input.actor.id,
          input.correlationId,
        ],
      );
      await this.insertDefinitionReferences(
        manager,
        input.tenantId,
        input.versionId,
        input.definition,
      );
      await manager.query(
        `
          UPDATE ${this.workflows}
          SET state_version = state_version + 1,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2
        `,
        [input.tenantId, input.workflowId],
      );
      await this.appendVersionAudit(manager, input, workflow.project_id);
      return input.versionId;
    });

    const version = await this.findVersionById(
      input.tenantId,
      input.workflowId,
      versionId,
    );
    if (version === undefined) {
      throw new Error('WORKFLOW_VERSION_CREATE_INCONSISTENT');
    }
    return version;
  }

  async findById(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          id,
          tenant_id,
          project_id,
          name,
          status,
          active_version_id,
          accepting_new_documents,
          cleanup_required,
          health,
          state_version,
          created_at,
          updated_at
        FROM ${this.workflows}
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, workflowId],
    )) as WorkflowRow[];

    return rows[0] === undefined ? undefined : mapWorkflow(rows[0]);
  }

  async findVersionById(
    tenantId: string,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersionRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          version.id,
          version.tenant_id,
          version.workflow_id,
          version.version_number,
          version.definition,
          version.definition_hash,
          version.created_by_actor_type,
          version.created_by_actor_id,
          version.correlation_id,
          version.created_at,
          profile.profile_id,
          profile.profile_version_id,
          profile.profile_kind,
          profile.output_schema_hash
        FROM ${this.versions} AS version
        JOIN ${this.profileReferences} AS profile
          ON profile.tenant_id = version.tenant_id
         AND profile.workflow_version_id = version.id
        WHERE version.tenant_id = $1
          AND version.workflow_id = $2
          AND version.id = $3
      `,
      [tenantId, workflowId, versionId],
    )) as WorkflowVersionRow[];
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }

    const references = (await this.dataSource.query(
      `
        SELECT connection_id, purpose
        FROM ${this.connectionReferences}
        WHERE tenant_id = $1 AND workflow_version_id = $2
        ORDER BY purpose, connection_id
      `,
      [tenantId, versionId],
    )) as ConnectionReferenceRow[];
    const definition =
      typeof row.definition === 'string'
        ? (JSON.parse(
            row.definition,
          ) as ValidatedWorkflowDefinition['definition'])
        : row.definition;

    return {
      createdAt: new Date(row.created_at),
      createdBy: {
        id: row.created_by_actor_id,
        type: row.created_by_actor_type,
      },
      definition: {
        connectionReferences: references.map((reference) => ({
          connectionId: reference.connection_id,
          purpose: reference.purpose,
        })),
        definition,
        definitionHash: row.definition_hash,
        profileReference: {
          outputSchemaHash: row.output_schema_hash,
          profileId: row.profile_id,
          profileKind: row.profile_kind,
          profileVersionId: row.profile_version_id,
        },
      },
      id: row.id,
      tenantId: row.tenant_id,
      versionNumber: Number(row.version_number),
      workflowId: row.workflow_id,
    };
  }

  async findLatestVersion(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowVersionRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT id
        FROM ${this.versions}
        WHERE tenant_id = $1 AND workflow_id = $2
        ORDER BY version_number DESC
        LIMIT 1
      `,
      [tenantId, workflowId],
    )) as { id: string }[];
    return rows[0] === undefined
      ? undefined
      : this.findVersionById(tenantId, workflowId, rows[0].id);
  }

  async listVersions(
    tenantId: string,
    workflowId: string,
    limit = 100,
  ): Promise<readonly WorkflowVersionRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('WORKFLOW_VERSION_LIST_LIMIT_INVALID');
    }
    const rows = (await this.dataSource.query(
      `
        SELECT id
        FROM ${this.versions}
        WHERE tenant_id = $1 AND workflow_id = $2
        ORDER BY version_number DESC
        LIMIT $3
      `,
      [tenantId, workflowId, limit],
    )) as { id: string }[];
    return Promise.all(
      rows.map(async (row) => {
        const version = await this.findVersionById(
          tenantId,
          workflowId,
          row.id,
        );
        if (version === undefined) {
          throw new Error('WORKFLOW_VERSION_LIST_INCONSISTENT');
        }
        return version;
      }),
    );
  }

  async listByProject(
    tenantId: string,
    projectId: string,
    limit = 50,
  ): Promise<readonly WorkflowRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('WORKFLOW_LIST_LIMIT_INVALID');
    }
    const rows = (await this.dataSource.query(
      `
        SELECT
          id, tenant_id, project_id, name, status, active_version_id,
          accepting_new_documents, cleanup_required, health, state_version,
          created_at, updated_at
        FROM ${this.workflows}
        WHERE tenant_id = $1 AND project_id = $2 AND status <> 'ARCHIVED'
        ORDER BY created_at DESC, id DESC
        LIMIT $3
      `,
      [tenantId, projectId, limit],
    )) as WorkflowRow[];
    return rows.map(mapWorkflow);
  }

  private async appendAudit(
    manager: EntityManager,
    input: CreateWorkflowInput,
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
        ) VALUES ($1, $2, $3, $4, $5, 'workflow.create', 'WORKFLOW', $6, 'SUCCEEDED', $7, $8, $9)
      `,
      [
        randomUUID(),
        input.tenantId,
        input.projectId,
        input.actor.type,
        input.actor.id,
        input.workflowId,
        input.correlationId,
        input.causationId,
        input.versionId,
      ],
    );
  }

  private async appendArchiveAudit(
    manager: EntityManager,
    input: ArchiveWorkflowInput,
    changed: boolean,
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
          causation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'WORKFLOW', $7, 'SUCCEEDED', $8, $9)
      `,
      [
        randomUUID(),
        input.tenantId,
        input.projectId,
        input.actor.type,
        input.actor.id,
        changed ? 'workflow.archive' : 'workflow.archive.noop',
        input.workflowId,
        input.correlationId,
        input.causationId,
      ],
    );
  }

  private async appendVersionAudit(
    manager: EntityManager,
    input: CreateWorkflowVersionInput,
    projectId: string,
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
        ) VALUES ($1, $2, $3, $4, $5, 'workflow.version.create', 'WORKFLOW_VERSION', $6, 'SUCCEEDED', $7, $8, $9)
      `,
      [
        randomUUID(),
        input.tenantId,
        projectId,
        input.actor.type,
        input.actor.id,
        input.versionId,
        input.correlationId,
        input.causationId,
        input.versionId,
      ],
    );
  }

  private async insertDefinitionReferences(
    manager: EntityManager,
    tenantId: string,
    versionId: string,
    definition: ValidatedWorkflowDefinition,
  ): Promise<void> {
    for (const reference of definition.connectionReferences) {
      await manager.query(
        `
          INSERT INTO ${this.connectionReferences} (
            tenant_id, workflow_version_id, connection_id, purpose
          ) VALUES ($1, $2, $3, $4)
        `,
        [tenantId, versionId, reference.connectionId, reference.purpose],
      );
    }

    await manager.query(
      `
        INSERT INTO ${this.profileReferences} (
          tenant_id,
          workflow_version_id,
          profile_id,
          profile_version_id,
          profile_kind,
          output_schema_hash
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        tenantId,
        versionId,
        definition.profileReference.profileId,
        definition.profileReference.profileVersionId,
        definition.profileReference.profileKind,
        definition.profileReference.outputSchemaHash,
      ],
    );
  }
}
