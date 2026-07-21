import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { createMessageEnvelope } from '@aiflow/messaging';
import {
  abortUploadSession,
  attachMultipartUpload,
  buildStorageObjectKey,
  completeUploadSession,
  createUploadSessionLifecycle,
  createUploadSessionPart,
  expireUploadSession,
  reconcileUploadSessionPart,
  type CommitUploadSessionInput,
  type CommitUploadSessionResult,
  type CreateUploadSessionInput,
  type PinUploadSessionPartInput,
  type PinUploadSessionPartResult,
  type UploadPlan,
  type UploadSessionPartRecord,
  type UploadSessionMutationInput,
  type UploadSessionRecord,
  type UploadSessionRepository,
} from '@aiflow/storage';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface UploadSessionRow {
  aborted_at: Date | string | null;
  client_checksum_algorithm: 'SHA256';
  client_checksum_value: string;
  completed_at: Date | string | null;
  content_type: string;
  created_at: Date | string;
  document_id: string | null;
  execution_id: string | null;
  expires_at: Date | string;
  id: string;
  multipart_upload_reference: string | null;
  original_filename: string;
  part_count: number | string | null;
  part_size_bytes: number | string | null;
  plan_type: UploadPlan['type'];
  project_id: string;
  size_bytes: number | string;
  state_version: number | string;
  status: UploadSessionRecord['status'];
  storage_object_id: string;
  tenant_id: string;
  updated_at: Date | string;
  workflow_id: string;
  workflow_version_id: string;
}

interface UploadSessionPartRow {
  checksum_algorithm: 'SHA256';
  checksum_value: string;
  created_at: Date | string;
  part_number: number | string;
  size_bytes: number | string;
  tenant_id: string;
  upload_session_id: string;
}

const columns = `
  id,
  tenant_id,
  project_id,
  workflow_id,
  workflow_version_id,
  storage_object_id,
  plan_type,
  part_size_bytes,
  part_count,
  multipart_upload_reference,
  status,
  state_version,
  original_filename,
  content_type,
  size_bytes,
  client_checksum_algorithm,
  client_checksum_value,
  document_id,
  execution_id,
  expires_at,
  created_at,
  updated_at,
  completed_at,
  aborted_at
`;

const mapSession = (row: UploadSessionRow): UploadSessionRecord => ({
  ...(row.aborted_at === null ? {} : { abortedAt: new Date(row.aborted_at) }),
  clientChecksum: {
    algorithm: row.client_checksum_algorithm,
    value: row.client_checksum_value,
  },
  ...(row.completed_at === null
    ? {}
    : { completedAt: new Date(row.completed_at) }),
  contentType: row.content_type,
  createdAt: new Date(row.created_at),
  ...(row.document_id === null ? {} : { documentId: row.document_id }),
  ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
  expiresAt: new Date(row.expires_at),
  id: row.id,
  ...(row.multipart_upload_reference === null
    ? {}
    : { multipartUploadReference: row.multipart_upload_reference }),
  originalFilename: row.original_filename,
  plan:
    row.plan_type === 'SINGLE_PUT'
      ? { type: 'SINGLE_PUT' }
      : {
          partCount: Number(row.part_count),
          partSizeBytes: Number(row.part_size_bytes),
          type: 'MULTIPART',
        },
  projectId: row.project_id,
  sizeBytes: Number(row.size_bytes),
  stateVersion: Number(row.state_version),
  status: row.status,
  storageObjectId: row.storage_object_id,
  tenantId: row.tenant_id,
  updatedAt: new Date(row.updated_at),
  workflowId: row.workflow_id,
  workflowVersionId: row.workflow_version_id,
});

const partColumns = `
  tenant_id,
  upload_session_id,
  part_number,
  size_bytes,
  checksum_algorithm,
  checksum_value,
  created_at
`;

const mapPart = (row: UploadSessionPartRow): UploadSessionPartRecord => ({
  checksum: {
    algorithm: row.checksum_algorithm,
    value: row.checksum_value,
  },
  createdAt: new Date(row.created_at),
  partNumber: Number(row.part_number),
  sizeBytes: Number(row.size_bytes),
  tenantId: row.tenant_id,
  uploadSessionId: row.upload_session_id,
});

const requestFingerprint = (input: CreateUploadSessionInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        clientChecksumValue: input.clientChecksumValue,
        contentType: input.contentType.trim().toLowerCase(),
        originalFilename: input.originalFilename.trim(),
        plan:
          input.plan.type === 'SINGLE_PUT'
            ? { type: 'SINGLE_PUT' }
            : {
                partCount: input.plan.partCount,
                partSizeBytes: input.plan.partSizeBytes,
                type: 'MULTIPART',
              },
        projectId: input.projectId,
        sizeBytes: input.sizeBytes,
        workflowId: input.workflowId,
      }),
    )
    .digest('hex');

type CloseKind = 'ABORTED' | 'EXPIRED';

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

export class PostgresUploadSessionRepository implements UploadSessionRepository {
  private readonly auditEvents: string;
  private readonly documents: string;
  private readonly executions: string;
  private readonly idempotency: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly parts: string;
  private readonly sessions: string;
  private readonly stages: string;
  private readonly storageObjects: string;
  private readonly versions: string;
  private readonly workflows: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.auditEvents = table(schema, 'audit_events');
    this.documents = table(schema, 'documents');
    this.executions = table(schema, 'executions');
    this.idempotency = table(schema, 'idempotency_records');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.parts = table(schema, 'upload_session_parts');
    this.sessions = table(schema, 'upload_sessions');
    this.stages = table(schema, 'execution_stages');
    this.storageObjects = table(schema, 'storage_objects');
    this.versions = table(schema, 'workflow_versions');
    this.workflows = table(schema, 'workflows');
  }

  async create(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    }
    if (input.retentionUntil.getTime() <= input.expiresAt.getTime()) {
      throw new Error('STORAGE_RETENTION_INVALID');
    }
    const fingerprint = requestFingerprint(input);

    const uploadSessionId = await this.dataSource.transaction(
      async (manager) => {
        const idempotency = await this.acquireIdempotency(
          manager,
          input,
          fingerprint,
        );
        if (idempotency !== undefined) {
          return idempotency;
        }

        const targets = (await manager.query(
          `
            SELECT
              workflow.active_version_id AS workflow_version_id,
              clock_timestamp() AS created_at
            FROM ${this.workflows} AS workflow
            JOIN ${this.versions} AS version
              ON version.tenant_id = workflow.tenant_id
             AND version.workflow_id = workflow.id
             AND version.id = workflow.active_version_id
            WHERE workflow.tenant_id = $1
              AND workflow.project_id = $2
              AND workflow.id = $3
              AND workflow.status = 'ACTIVE'
              AND workflow.accepting_new_documents
            FOR UPDATE OF workflow
          `,
          [input.tenantId, input.projectId, input.workflowId],
        )) as {
          created_at: Date | string;
          workflow_version_id: string;
        }[];
        const target = targets[0];
        if (target === undefined) {
          throw new Error('WORKFLOW_NOT_ACCEPTING_DOCUMENTS');
        }

        const session = createUploadSessionLifecycle({
          clientChecksumValue: input.clientChecksumValue,
          contentType: input.contentType,
          createdAt: new Date(target.created_at),
          expiresAt: input.expiresAt,
          id: input.uploadSessionId,
          originalFilename: input.originalFilename,
          plan: input.plan,
          projectId: input.projectId,
          sizeBytes: input.sizeBytes,
          storageObjectId: input.storageObjectId,
          tenantId: input.tenantId,
          workflowId: input.workflowId,
          workflowVersionId: target.workflow_version_id,
        });

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
            ) VALUES ($1, $2, $3, 'SOURCE_DOCUMENT', 'RESERVED', 'PRIMARY', $4, $5)
          `,
          [
            input.storageObjectId,
            input.tenantId,
            input.projectId,
            buildStorageObjectKey(input.tenantId, input.storageObjectId),
            input.retentionUntil,
          ],
        );
        await manager.query(
          `
            INSERT INTO ${this.sessions} (
              id,
              tenant_id,
              project_id,
              workflow_id,
              workflow_version_id,
              storage_object_id,
              plan_type,
              part_size_bytes,
              part_count,
              original_filename,
              content_type,
              size_bytes,
              client_checksum_algorithm,
              client_checksum_value,
              expires_at,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              'SHA256', $13, $14, $15, $15
            )
          `,
          [
            session.id,
            session.tenantId,
            session.projectId,
            session.workflowId,
            session.workflowVersionId,
            session.storageObjectId,
            session.plan.type,
            session.plan.type === 'MULTIPART'
              ? session.plan.partSizeBytes
              : null,
            session.plan.type === 'MULTIPART' ? session.plan.partCount : null,
            session.originalFilename,
            session.contentType,
            session.sizeBytes,
            session.clientChecksum.value,
            session.expiresAt,
            session.createdAt,
          ],
        );
        await this.appendAudit(manager, input, 'upload-session.created');
        return session.id;
      },
    );

    const session = await this.findById(input.tenantId, uploadSessionId);
    if (session === undefined) {
      throw new Error('UPLOAD_SESSION_CREATE_INCONSISTENT');
    }
    return session;
  }

  async findById(
    tenantId: string,
    uploadSessionId: string,
  ): Promise<UploadSessionRecord | undefined> {
    const rows = (await this.dataSource.query(
      `SELECT ${columns} FROM ${this.sessions} WHERE tenant_id = $1 AND id = $2`,
      [tenantId, uploadSessionId],
    )) as UploadSessionRow[];
    return rows[0] === undefined ? undefined : mapSession(rows[0]);
  }

  async findParts(
    tenantId: string,
    uploadSessionId: string,
  ): Promise<readonly UploadSessionPartRecord[]> {
    const rows = (await this.dataSource.query(
      `
        SELECT ${partColumns}
        FROM ${this.parts}
        WHERE tenant_id = $1 AND upload_session_id = $2
        ORDER BY part_number
      `,
      [tenantId, uploadSessionId],
    )) as UploadSessionPartRow[];
    return rows.map(mapPart);
  }

  async commitCompletion(
    input: CommitUploadSessionInput,
  ): Promise<CommitUploadSessionResult> {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    }
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lock(manager, input);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ uploadSessionId: current.session.id }))
        .digest('hex');
      await this.acquireCompletionIdempotency(manager, input, fingerprint);
      if (current.session.status === 'COMPLETED') {
        if (
          current.session.documentId === undefined ||
          current.session.executionId === undefined
        ) {
          throw new Error('UPLOAD_SESSION_COMPLETION_INCONSISTENT');
        }
        await this.completeIdempotency(
          manager,
          input,
          fingerprint,
          current.session.documentId,
          current.session.executionId,
        );
        return {
          documentId: current.session.documentId,
          executionId: current.session.executionId,
          session: current.session,
        };
      }

      const workflowRows = (await manager.query(
        `
          SELECT COALESCE(
            (version.definition #>> '{reviewPolicy,required}')::boolean,
            false
          ) AS review_required
          FROM ${this.workflows} AS workflow
          JOIN ${this.versions} AS version
            ON version.tenant_id = workflow.tenant_id
           AND version.workflow_id = workflow.id
           AND version.id = workflow.active_version_id
          WHERE workflow.tenant_id = $1
            AND workflow.project_id = $2
            AND workflow.id = $3
            AND workflow.active_version_id = $4
            AND workflow.status = 'ACTIVE'
            AND workflow.accepting_new_documents
          FOR UPDATE OF workflow
        `,
        [
          current.session.tenantId,
          current.session.projectId,
          current.session.workflowId,
          current.session.workflowVersionId,
        ],
      )) as { review_required: boolean }[];
      const workflow = workflowRows[0];
      if (workflow === undefined) {
        throw new Error('WORKFLOW_NOT_ACCEPTING_DOCUMENTS');
      }

      const next = completeUploadSession(current.session, {
        documentId: input.documentId,
        executionId: input.executionId,
        expectedStateVersion: current.session.stateVersion,
        now: current.now,
      });
      const storageRows = mutationRows<{ id: string }>(
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
                available_at = $12,
                updated_at = $12,
                failure_code = NULL
            WHERE tenant_id = $1
              AND id = $2
              AND project_id = $3
              AND status = 'RESERVED'
              AND object_key = $13
            RETURNING id
          `,
          [
            current.session.tenantId,
            current.session.storageObjectId,
            current.session.projectId,
            input.metadata.versionId,
            input.metadata.sizeBytes,
            input.metadata.contentType,
            input.metadata.checksum.algorithm,
            input.metadata.checksum.type,
            input.metadata.checksum.value,
            input.metadata.encryptionMode,
            input.metadata.encryptionKeyRef ?? null,
            current.now,
            input.metadata.key,
          ],
        ),
      );
      if (storageRows.length !== 1) {
        throw new Error('UPLOAD_SESSION_STORAGE_TRANSITION_CONFLICT');
      }

      await manager.query(
        `
          INSERT INTO ${this.documents} (
            id,
            tenant_id,
            project_id,
            source_connector_id,
            source_identity,
            source_version,
            source_storage_object_id,
            size_bytes,
            content_type,
            checksum_algorithm,
            checksum_value,
            original_filename,
            staged_at
          ) VALUES (
            $1, $2, $3, 'direct-upload', $4, $5, $6, $7, $8, $9, $10, $11, $12
          )
        `,
        [
          input.documentId,
          current.session.tenantId,
          current.session.projectId,
          current.session.id,
          input.metadata.versionId,
          current.session.storageObjectId,
          input.metadata.sizeBytes,
          input.metadata.contentType,
          input.metadata.checksum.algorithm,
          input.metadata.checksum.value,
          current.session.originalFilename,
          current.now,
        ],
      );
      await manager.query('SET CONSTRAINTS executions_root_fk DEFERRED');
      await manager.query(
        `
          INSERT INTO ${this.executions} (
            id,
            tenant_id,
            project_id,
            workflow_id,
            workflow_version_id,
            document_id,
            root_execution_id,
            status,
            current_stage,
            actor_type,
            actor_id,
            correlation_id,
            causation_id,
            created_at,
            transitioned_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $1, 'QUEUED', 'EXTRACT',
            $7, $8, $9, $10, $11, $11
          )
        `,
        [
          input.executionId,
          current.session.tenantId,
          current.session.projectId,
          current.session.workflowId,
          current.session.workflowVersionId,
          input.documentId,
          input.actor.type,
          input.actor.id,
          input.correlationId,
          input.causationId,
          current.now,
        ],
      );
      for (const stage of ['EXTRACT', 'MAP', 'REVIEW', 'DELIVER'] as const) {
        await manager.query(
          `
            INSERT INTO ${this.stages} (
              id, tenant_id, execution_id, stage, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $6)
          `,
          [
            randomUUID(),
            current.session.tenantId,
            input.executionId,
            stage,
            stage === 'REVIEW' && !workflow.review_required
              ? 'SKIPPED'
              : 'PENDING',
            current.now,
          ],
        );
      }

      const message = createMessageEnvelope({
        actor: input.actor,
        causationId: input.causationId,
        correlationId: input.correlationId,
        data: {
          executionId: input.executionId,
          expectedStateVersion: 0,
          stage: 'EXTRACT',
        },
        occurredAt: current.now,
        projectId: current.session.projectId,
        tenantId: current.session.tenantId,
        type: 'aiflow.execution.stage.extract.requested.v1',
      });
      await this.outbox.append(queryRunner(manager), {
        aggregateId: input.executionId,
        aggregateType: 'EXECUTION',
        availableAt: current.now,
        envelope: message,
      });

      const sessionRows = mutationRows<UploadSessionRow>(
        await manager.query(
          `
            UPDATE ${this.sessions}
            SET status = 'COMPLETED',
                state_version = state_version + 1,
                document_id = $4,
                execution_id = $5,
                completed_at = $6,
                updated_at = $6
            WHERE tenant_id = $1 AND id = $2 AND state_version = $3
            RETURNING ${columns}
          `,
          [
            current.session.tenantId,
            current.session.id,
            current.session.stateVersion,
            input.documentId,
            input.executionId,
            next.completedAt,
          ],
        ),
      );
      if (sessionRows[0] === undefined) {
        throw new Error('UPLOAD_SESSION_TRANSITION_CONFLICT');
      }
      await this.completeIdempotency(
        manager,
        input,
        fingerprint,
        input.documentId,
        input.executionId,
      );
      await this.appendAudit(
        manager,
        { ...input, projectId: current.session.projectId },
        'upload-session.completed',
      );
      await this.appendExecutionCreatedAudit(manager, input, current.session);
      return {
        documentId: input.documentId,
        executionId: input.executionId,
        session: mapSession(sessionRows[0]),
      };
    });
  }

  async pinPart(
    input: PinUploadSessionPartInput,
  ): Promise<PinUploadSessionPartResult> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lock(manager, input);
      const candidate = createUploadSessionPart(current.session, {
        checksumValue: input.checksumValue,
        contentLength: input.contentLength,
        now: current.now,
        partNumber: input.partNumber,
      });
      const inserted = mutationRows<UploadSessionPartRow>(
        await manager.query(
          `
            INSERT INTO ${this.parts} (
              tenant_id,
              upload_session_id,
              part_number,
              size_bytes,
              checksum_algorithm,
              checksum_value,
              created_at
            ) VALUES ($1, $2, $3, $4, 'SHA256', $5, $6)
            ON CONFLICT (tenant_id, upload_session_id, part_number) DO NOTHING
            RETURNING ${partColumns}
          `,
          [
            candidate.tenantId,
            candidate.uploadSessionId,
            candidate.partNumber,
            candidate.sizeBytes,
            candidate.checksum.value,
            candidate.createdAt,
          ],
        ),
      );
      if (inserted[0] !== undefined) {
        await this.appendAudit(
          manager,
          { ...input, projectId: current.session.projectId },
          'upload-session.part-pinned',
        );
        return { part: mapPart(inserted[0]), session: current.session };
      }

      const existing = (await manager.query(
        `
          SELECT ${partColumns}
          FROM ${this.parts}
          WHERE tenant_id = $1
            AND upload_session_id = $2
            AND part_number = $3
        `,
        [input.tenantId, input.uploadSessionId, input.partNumber],
      )) as UploadSessionPartRow[];
      if (existing[0] === undefined) {
        throw new Error('UPLOAD_SESSION_PART_PIN_INCONSISTENT');
      }
      return {
        part: reconcileUploadSessionPart(mapPart(existing[0]), candidate),
        session: current.session,
      };
    });
  }

  async attachMultipartUpload(
    input: UploadSessionMutationInput & {
      readonly multipartUploadReference: string;
    },
  ): Promise<UploadSessionRecord> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lock(manager, input);
      const next = attachMultipartUpload(current.session, {
        expectedStateVersion: input.expectedStateVersion,
        multipartUploadReference: input.multipartUploadReference,
        now: current.now,
      });
      if (next === current.session) {
        return current.session;
      }
      const rows = mutationRows<UploadSessionRow>(
        await manager.query(
          `
            UPDATE ${this.sessions}
            SET multipart_upload_reference = $4,
                state_version = state_version + 1,
                updated_at = $5
            WHERE tenant_id = $1 AND id = $2 AND state_version = $3
            RETURNING ${columns}
          `,
          [
            input.tenantId,
            input.uploadSessionId,
            input.expectedStateVersion,
            input.multipartUploadReference,
            next.updatedAt,
          ],
        ),
      );
      if (rows[0] === undefined) {
        throw new Error('UPLOAD_SESSION_TRANSITION_CONFLICT');
      }
      await this.appendAudit(
        manager,
        { ...input, projectId: current.session.projectId },
        'upload-session.multipart-bound',
      );
      return mapSession(rows[0]);
    });
  }

  async abort(input: UploadSessionMutationInput): Promise<UploadSessionRecord> {
    return this.close(input, 'ABORTED');
  }

  async expire(
    input: UploadSessionMutationInput,
  ): Promise<UploadSessionRecord> {
    return this.close(input, 'EXPIRED');
  }

  private async acquireCompletionIdempotency(
    manager: EntityManager,
    input: CommitUploadSessionInput,
    fingerprint: string,
  ): Promise<void> {
    const inserted = (await manager.query(
      `
        INSERT INTO ${this.idempotency} (
          id,
          tenant_id,
          operation_scope,
          idempotency_key,
          request_fingerprint,
          status,
          expires_at
        ) VALUES (
          $1, $2, 'upload-session.complete', $3, $4, 'IN_PROGRESS',
          clock_timestamp() + interval '90 days'
        )
        ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
        RETURNING id
      `,
      [randomUUID(), input.tenantId, input.idempotencyKey, fingerprint],
    )) as { id: string }[];
    if (inserted.length > 0) {
      return;
    }

    const existing = (await manager.query(
      `
        SELECT request_fingerprint, status
        FROM ${this.idempotency}
        WHERE tenant_id = $1
          AND operation_scope = 'upload-session.complete'
          AND idempotency_key = $2
        FOR UPDATE
      `,
      [input.tenantId, input.idempotencyKey],
    )) as { request_fingerprint: string; status: string }[];
    if (existing[0]?.request_fingerprint !== fingerprint) {
      throw new Error('IDEMPOTENCY_KEY_REUSED');
    }
    if (existing[0]?.status !== 'COMPLETED') {
      throw new Error('IDEMPOTENCY_IN_PROGRESS');
    }
  }

  private async completeIdempotency(
    manager: EntityManager,
    input: CommitUploadSessionInput,
    fingerprint: string,
    documentId: string,
    executionId: string,
  ): Promise<void> {
    const rows = mutationRows<{ id: string }>(
      await manager.query(
        `
          UPDATE ${this.idempotency}
          SET status = 'COMPLETED',
              resource_type = 'EXECUTION',
              resource_id = $4,
              response = $5::jsonb,
              completed_at = COALESCE(completed_at, clock_timestamp())
          WHERE tenant_id = $1
            AND operation_scope = 'upload-session.complete'
            AND idempotency_key = $2
            AND request_fingerprint = $3
            AND status IN ('IN_PROGRESS', 'COMPLETED')
          RETURNING id
        `,
        [
          input.tenantId,
          input.idempotencyKey,
          fingerprint,
          executionId,
          JSON.stringify({
            documentId,
            executionId,
            uploadSessionId: input.uploadSessionId,
          }),
        ],
      ),
    );
    if (rows.length !== 1) {
      throw new Error('IDEMPOTENCY_COMPLETION_CONFLICT');
    }
  }

  private async acquireIdempotency(
    manager: EntityManager,
    input: CreateUploadSessionInput,
    fingerprint: string,
  ): Promise<string | undefined> {
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
          $1, $2, 'upload-session.create', $3, $4, 'COMPLETED',
          'UPLOAD_SESSION', $5, clock_timestamp(), clock_timestamp() + interval '90 days'
        )
        ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
        RETURNING resource_id
      `,
      [
        randomUUID(),
        input.tenantId,
        input.idempotencyKey,
        fingerprint,
        input.uploadSessionId,
      ],
    )) as { resource_id: string }[];
    if (inserted.length > 0) {
      return undefined;
    }

    const existing = (await manager.query(
      `
        SELECT request_fingerprint, resource_id
        FROM ${this.idempotency}
        WHERE tenant_id = $1
          AND operation_scope = 'upload-session.create'
          AND idempotency_key = $2
        FOR UPDATE
      `,
      [input.tenantId, input.idempotencyKey],
    )) as { request_fingerprint: string; resource_id: string | null }[];
    if (existing[0]?.request_fingerprint !== fingerprint) {
      throw new Error('IDEMPOTENCY_KEY_REUSED');
    }
    if (existing[0]?.resource_id === null || existing[0] === undefined) {
      throw new Error('IDEMPOTENCY_IN_PROGRESS');
    }
    return existing[0].resource_id;
  }

  private async close(
    input: UploadSessionMutationInput,
    kind: CloseKind,
  ): Promise<UploadSessionRecord> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lock(manager, input);
      const next =
        kind === 'ABORTED'
          ? abortUploadSession(current.session, {
              expectedStateVersion: input.expectedStateVersion,
              now: current.now,
            })
          : expireUploadSession(current.session, {
              expectedStateVersion: input.expectedStateVersion,
              now: current.now,
            });
      if (next === current.session) {
        return current.session;
      }

      const abandoned = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.storageObjects}
            SET status = 'ABANDONED',
                state_version = state_version + 1,
                failure_code = $3,
                updated_at = $4
            WHERE tenant_id = $1
              AND id = $2
              AND status = 'RESERVED'
            RETURNING id
          `,
          [
            input.tenantId,
            current.session.storageObjectId,
            kind === 'ABORTED'
              ? 'UPLOAD_SESSION_ABORTED'
              : 'UPLOAD_SESSION_EXPIRED',
            next.updatedAt,
          ],
        ),
      );
      if (abandoned.length !== 1) {
        throw new Error('UPLOAD_SESSION_STORAGE_TRANSITION_CONFLICT');
      }

      const rows = mutationRows<UploadSessionRow>(
        await manager.query(
          `
            UPDATE ${this.sessions}
            SET status = $4,
                state_version = state_version + 1,
                aborted_at = $5,
                updated_at = $5
            WHERE tenant_id = $1 AND id = $2 AND state_version = $3
            RETURNING ${columns}
          `,
          [
            input.tenantId,
            input.uploadSessionId,
            input.expectedStateVersion,
            kind,
            next.updatedAt,
          ],
        ),
      );
      if (rows[0] === undefined) {
        throw new Error('UPLOAD_SESSION_TRANSITION_CONFLICT');
      }
      await this.appendAudit(
        manager,
        { ...input, projectId: current.session.projectId },
        kind === 'ABORTED'
          ? 'upload-session.aborted'
          : 'upload-session.expired',
      );
      return mapSession(rows[0]);
    });
  }

  private async lock(
    manager: EntityManager,
    input: Pick<UploadSessionMutationInput, 'tenantId' | 'uploadSessionId'>,
  ): Promise<{ readonly now: Date; readonly session: UploadSessionRecord }> {
    const rows = (await manager.query(
      `
        SELECT ${columns}, clock_timestamp() AS database_now
        FROM ${this.sessions}
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `,
      [input.tenantId, input.uploadSessionId],
    )) as (UploadSessionRow & { database_now: Date | string })[];
    if (rows[0] === undefined) {
      throw new Error('UPLOAD_SESSION_NOT_FOUND');
    }
    return {
      now: new Date(rows[0].database_now),
      session: mapSession(rows[0]),
    };
  }

  private async appendAudit(
    manager: EntityManager,
    input: Pick<
      UploadSessionMutationInput,
      'actor' | 'causationId' | 'correlationId' | 'tenantId' | 'uploadSessionId'
    > & { readonly projectId?: string },
    eventType: string,
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
        ) VALUES ($1, $2, $3, $4, $5, $6, 'UPLOAD_SESSION', $7, 'SUCCEEDED', $8, $9)
      `,
      [
        randomUUID(),
        input.tenantId,
        input.projectId ?? null,
        input.actor.type,
        input.actor.id,
        eventType,
        input.uploadSessionId,
        input.correlationId,
        input.causationId,
      ],
    );
  }

  private async appendExecutionCreatedAudit(
    manager: EntityManager,
    input: CommitUploadSessionInput,
    session: UploadSessionRecord,
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
          $1, $2, $3, $4, $5, 'execution.create', 'EXECUTION', $6,
          'SUCCEEDED', $7, $8, $9
        )
      `,
      [
        randomUUID(),
        session.tenantId,
        session.projectId,
        input.actor.type,
        input.actor.id,
        input.executionId,
        input.correlationId,
        input.causationId,
        session.workflowVersionId,
      ],
    );
  }
}
