import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import type {
  CreateWorkflowInput,
  ValidatedWorkflowDefinition,
  WorkflowRecord,
  WorkflowRepository,
  WorkflowVersionRecord,
} from '@aiflow/workflows';

import { table } from './sql';

interface WorkflowRow {
  accepting_new_documents: boolean;
  active_version_id: string | null;
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

const mapWorkflow = (row: WorkflowRow): WorkflowRecord => ({
  acceptingNewDocuments: row.accepting_new_documents,
  ...(row.active_version_id === null
    ? {}
    : { activeVersionId: row.active_version_id }),
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
    this.profileReferences = table(schema, 'workflow_version_profile_refs');
    this.versions = table(schema, 'workflow_versions');
    this.workflows = table(schema, 'workflows');
  }

  async create(input: CreateWorkflowInput): Promise<{
    readonly version: WorkflowVersionRecord;
    readonly workflow: WorkflowRecord;
  }> {
    if (input.name.trim().length === 0 || input.name.length > 180) {
      throw new Error('WORKFLOW_NAME_INVALID');
    }

    await this.dataSource.transaction(async (manager) => {
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

      for (const reference of input.definition.connectionReferences) {
        await manager.query(
          `
            INSERT INTO ${this.connectionReferences} (
              tenant_id, workflow_version_id, connection_id, purpose
            ) VALUES ($1, $2, $3, $4)
          `,
          [
            input.tenantId,
            input.versionId,
            reference.connectionId,
            reference.purpose,
          ],
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
          input.tenantId,
          input.versionId,
          input.definition.profileReference.profileId,
          input.definition.profileReference.profileVersionId,
          input.definition.profileReference.profileKind,
          input.definition.profileReference.outputSchemaHash,
        ],
      );
      await this.appendAudit(manager, input);
    });

    const workflow = await this.findById(input.tenantId, input.workflowId);
    const version = await this.findVersionById(
      input.tenantId,
      input.workflowId,
      input.versionId,
    );
    if (workflow === undefined || version === undefined) {
      throw new Error('WORKFLOW_CREATE_INCONSISTENT');
    }

    return { version, workflow };
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
}
