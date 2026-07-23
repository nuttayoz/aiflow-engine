import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import type {
  SharePointIngestionClaim,
  SharePointIngestionRepository,
} from '@aiflow/connector-microsoft-sharepoint';
import { createMessageEnvelope } from '@aiflow/messaging';
import { buildStorageObjectKey } from '@aiflow/storage';

import { PostgresOutboxRepository } from './outbox.repository';
import { mutationRows, table } from './sql';

interface ClaimRow {
  binding_id: string;
  connection_id: string;
  drive_id: string;
  file_name: string;
  ingestion_id: string;
  item_id: string;
  project_id: string;
  source_version: string;
  source_version_kind: 'CTAG' | 'ETAG';
}

interface CompletionRow {
  binding_id: string;
  drive_id: string;
  file_name: string;
  item_id: string;
  project_id: string;
  review_required: boolean;
  source_version: string;
  storage_key: string;
  storage_object_id: string;
  workflow_id: string;
  workflow_version_id: string;
}

const queryRunner = (manager: EntityManager): QueryRunner => {
  if (manager.queryRunner === undefined) {
    throw new Error('DATABASE_TRANSACTION_REQUIRED');
  }
  return manager.queryRunner;
};

const sourceIdentity = (claim: {
  readonly bindingId: string;
  readonly driveId: string;
  readonly itemId: string;
}): string =>
  `sharepoint:${createHash('sha256')
    .update(claim.bindingId)
    .update('\0')
    .update(claim.driveId)
    .update('\0')
    .update(claim.itemId)
    .digest('hex')}`;

export class PostgresSharePointIngestionRepository implements SharePointIngestionRepository {
  private readonly bindings: string;
  private readonly documents: string;
  private readonly executions: string;
  private readonly inbox: string;
  private readonly ingestions: string;
  private readonly items: string;
  private readonly outbox: PostgresOutboxRepository;
  private readonly stages: string;
  private readonly storageObjects: string;
  private readonly versions: string;
  private readonly watches: string;
  private readonly workflows: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.bindings = table(schema, 'connector_provisioning_bindings');
    this.documents = table(schema, 'documents');
    this.executions = table(schema, 'executions');
    this.inbox = table(schema, 'inbox_messages');
    this.ingestions = table(schema, 'document_ingestions');
    this.items = table(schema, 'sharepoint_drive_items');
    this.outbox = new PostgresOutboxRepository(dataSource, schema);
    this.stages = table(schema, 'execution_stages');
    this.storageObjects = table(schema, 'storage_objects');
    this.versions = table(schema, 'workflow_versions');
    this.watches = table(schema, 'sharepoint_drive_watches');
    this.workflows = table(schema, 'workflows');
  }

  async claim(
    input: Parameters<SharePointIngestionRepository['claim']>[0],
  ): Promise<SharePointIngestionClaim | undefined> {
    if (
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 300_000
    ) {
      throw new Error('LEASE_DURATION_INVALID');
    }
    const storageObjectId = randomUUID();
    const row = await this.dataSource.transaction(async (manager) => {
      const inbox = mutationRows<{ id: string }>(
        await manager.query(
          `
            INSERT INTO ${this.inbox} (
              id,
              consumer_name,
              message_id,
              message_type,
              tenant_id,
              project_id,
              target_type,
              target_id,
              outcome,
              expires_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              'DOCUMENT_INGESTION', $7, 'CLAIMED',
              clock_timestamp() + interval '30 days'
            )
            ON CONFLICT (consumer_name, message_id) DO NOTHING
            RETURNING id
          `,
          [
            randomUUID(),
            input.consumerName,
            input.messageId,
            input.messageType,
            input.tenantId,
            input.projectId,
            input.ingestionId,
          ],
        ),
      );
      if (inbox.length === 0) return undefined;

      const candidates = (await manager.query(
        `
          SELECT
            ingestion.id AS ingestion_id,
            ingestion.project_id,
            ingestion.connector_provisioning_binding_id AS binding_id,
            ingestion.drive_id,
            ingestion.item_id,
            ingestion.source_version_kind,
            ingestion.source_version,
            watch.connection_id,
            item.name AS file_name
          FROM ${this.ingestions} AS ingestion
          JOIN ${this.bindings} AS binding
            ON binding.tenant_id = ingestion.tenant_id
           AND binding.id = ingestion.connector_provisioning_binding_id
          JOIN ${this.watches} AS watch
            ON watch.tenant_id = ingestion.tenant_id
           AND watch.id = ingestion.watch_id
          JOIN ${this.items} AS item
            ON item.tenant_id = ingestion.tenant_id
           AND item.watch_id = ingestion.watch_id
           AND item.item_id = ingestion.item_id
          WHERE ingestion.tenant_id = $1
            AND ingestion.project_id = $2
            AND ingestion.id = $3
            AND ingestion.state_version = $4
            AND (
              ingestion.status = 'PENDING'
              OR (
                ingestion.status = 'WAITING_RETRY'
                AND ingestion.next_attempt_at <= clock_timestamp()
              )
            )
            AND ingestion.storage_object_id IS NULL
            AND binding.status IN ('ACTIVE', 'DRAINING')
            AND binding.accepting_new_documents
            AND item.item_kind = 'FILE'
            AND item.name IS NOT NULL
          FOR UPDATE OF ingestion
        `,
        [
          input.tenantId,
          input.projectId,
          input.ingestionId,
          input.expectedStateVersion,
        ],
      )) as ClaimRow[];
      const candidate = candidates[0];
      if (candidate === undefined) {
        await manager.query(
          `
            UPDATE ${this.inbox}
            SET outcome = 'STALE'
            WHERE consumer_name = $1 AND message_id = $2
          `,
          [input.consumerName, input.messageId],
        );
        return undefined;
      }
      const storageKey = buildStorageObjectKey(input.tenantId, storageObjectId);
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
          ) VALUES (
            $1, $2, $3, 'SOURCE_DOCUMENT', 'RESERVED', 'PRIMARY', $4,
            clock_timestamp() + interval '30 days'
          )
        `,
        [storageObjectId, input.tenantId, input.projectId, storageKey],
      );
      const claimed = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.ingestions}
            SET status = 'RUNNING',
                state_version = state_version + 1,
                attempt_count = attempt_count + 1,
                next_attempt_at = NULL,
                lease_owner = $5,
                lease_expires_at = clock_timestamp() + ($6 * interval '1 millisecond'),
                storage_object_id = $7,
                failure_code = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND project_id = $2
              AND id = $3
              AND state_version = $4
            RETURNING id
          `,
          [
            input.tenantId,
            input.projectId,
            input.ingestionId,
            input.expectedStateVersion,
            input.leaseOwner,
            input.leaseDurationMs,
            storageObjectId,
          ],
        ),
      );
      if (claimed.length !== 1) {
        throw new Error('SHAREPOINT_INGESTION_STATE_CONFLICT');
      }
      return { ...candidate, storageKey };
    });
    if (row === undefined) return undefined;
    return {
      bindingId: row.binding_id,
      connectionId: row.connection_id,
      driveId: row.drive_id,
      fileName: row.file_name,
      ingestionId: row.ingestion_id,
      itemId: row.item_id,
      projectId: row.project_id,
      sourceVersion: row.source_version,
      sourceVersionKind: row.source_version_kind,
      storageKey: row.storageKey,
      storageObjectId,
      tenantId: input.tenantId,
    };
  }

  async complete(
    input: Parameters<SharePointIngestionRepository['complete']>[0],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT
            ingestion.project_id,
            ingestion.connector_provisioning_binding_id AS binding_id,
            ingestion.drive_id,
            ingestion.item_id,
            ingestion.source_version,
            ingestion.storage_object_id,
            binding.workflow_id,
            binding.workflow_version_id,
            item.name AS file_name,
            storage.object_key AS storage_key,
            COALESCE(
              (version.definition #>> '{reviewPolicy,required}')::boolean,
              false
            ) AS review_required
          FROM ${this.ingestions} AS ingestion
          JOIN ${this.bindings} AS binding
            ON binding.tenant_id = ingestion.tenant_id
           AND binding.id = ingestion.connector_provisioning_binding_id
          JOIN ${this.items} AS item
            ON item.tenant_id = ingestion.tenant_id
           AND item.watch_id = ingestion.watch_id
           AND item.item_id = ingestion.item_id
          JOIN ${this.storageObjects} AS storage
            ON storage.tenant_id = ingestion.tenant_id
           AND storage.id = ingestion.storage_object_id
          JOIN ${this.workflows} AS workflow
            ON workflow.tenant_id = ingestion.tenant_id
           AND workflow.project_id = ingestion.project_id
           AND workflow.id = ingestion.workflow_id
           AND workflow.active_version_id = ingestion.workflow_version_id
          JOIN ${this.versions} AS version
            ON version.tenant_id = workflow.tenant_id
           AND version.workflow_id = workflow.id
           AND version.id = workflow.active_version_id
          WHERE ingestion.tenant_id = $1
            AND ingestion.id = $2
            AND ingestion.status = 'RUNNING'
            AND ingestion.lease_owner = $3
            AND ingestion.lease_expires_at > clock_timestamp()
            AND ingestion.storage_object_id = $4
            AND binding.status IN ('ACTIVE', 'DRAINING')
            AND binding.accepting_new_documents
            AND workflow.status = 'ACTIVE'
            AND workflow.accepting_new_documents
            AND item.item_kind = 'FILE'
            AND CASE ingestion.source_version_kind
              WHEN 'CTAG' THEN item.c_tag = ingestion.source_version
              ELSE item.e_tag = ingestion.source_version
            END
            AND storage.status = 'RESERVED'
            AND storage.object_key = $5
          FOR UPDATE OF ingestion, workflow, storage
        `,
        [
          input.claim.tenantId,
          input.claim.ingestionId,
          input.leaseOwner,
          input.claim.storageObjectId,
          input.metadata.key,
        ],
      )) as CompletionRow[];
      const current = rows[0];
      if (current === undefined) {
        throw new Error('SHAREPOINT_INGESTION_LEASE_LOST');
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
                updated_at = clock_timestamp(),
                failure_code = NULL
            WHERE tenant_id = $1
              AND id = $2
              AND object_key = $3
              AND status = 'RESERVED'
            RETURNING id
          `,
          [
            input.claim.tenantId,
            input.claim.storageObjectId,
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
        throw new Error('SHAREPOINT_INGESTION_STORAGE_CONFLICT');
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
            content_sha256,
            content_sha256_verified_at,
            original_filename,
            staged_at
          ) VALUES (
            $1, $2, $3, 'microsoft-sharepoint', $4, $5, $6, $7, $8,
            'SHA256', $9, $10, clock_timestamp(), $11, clock_timestamp()
          )
        `,
        [
          input.documentId,
          input.claim.tenantId,
          current.project_id,
          sourceIdentity({
            bindingId: current.binding_id,
            driveId: current.drive_id,
            itemId: current.item_id,
          }),
          current.source_version,
          input.claim.storageObjectId,
          input.metadata.sizeBytes,
          input.metadata.contentType,
          input.metadata.checksum.value,
          Buffer.from(input.metadata.checksum.value, 'base64').toString('hex'),
          current.file_name,
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
            'SERVICE', 'microsoft-sharepoint-ingest', $7, $8,
            clock_timestamp(), clock_timestamp()
          )
        `,
        [
          input.executionId,
          input.claim.tenantId,
          current.project_id,
          current.workflow_id,
          current.workflow_version_id,
          input.documentId,
          input.claim.ingestionId,
          input.claim.ingestionId,
        ],
      );
      for (const stage of ['EXTRACT', 'MAP', 'REVIEW', 'DELIVER'] as const) {
        await manager.query(
          `
            INSERT INTO ${this.stages} (
              id, tenant_id, execution_id, stage, status
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [
            randomUUID(),
            input.claim.tenantId,
            input.executionId,
            stage,
            stage === 'REVIEW' && !current.review_required
              ? 'SKIPPED'
              : 'PENDING',
          ],
        );
      }
      const envelope = createMessageEnvelope({
        actor: { id: 'microsoft-sharepoint-ingest', type: 'SERVICE' },
        causationId: input.claim.ingestionId,
        correlationId: input.claim.ingestionId,
        data: {
          executionId: input.executionId,
          expectedStateVersion: 0,
          stage: 'EXTRACT',
        },
        projectId: current.project_id,
        tenantId: input.claim.tenantId,
        type: 'aiflow.execution.stage.extract.requested.v1',
      });
      await this.outbox.append(queryRunner(manager), {
        aggregateId: input.executionId,
        aggregateType: 'EXECUTION',
        envelope,
      });
      const ingestion = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.ingestions}
            SET status = 'SUCCEEDED',
                state_version = state_version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                document_id = $4,
                execution_id = $5,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND lease_owner = $3
            RETURNING id
          `,
          [
            input.claim.tenantId,
            input.claim.ingestionId,
            input.leaseOwner,
            input.documentId,
            input.executionId,
          ],
        ),
      );
      if (ingestion.length !== 1) {
        throw new Error('SHAREPOINT_INGESTION_STATE_CONFLICT');
      }
    });
  }

  async defer(
    input: Parameters<SharePointIngestionRepository['defer']>[0],
  ): Promise<void> {
    if (
      !Number.isFinite(input.retryAt.getTime()) ||
      input.retryAt.getTime() <= Date.now() ||
      input.retryAt.getTime() > Date.now() + 24 * 60 * 60 * 1_000
    ) {
      throw new Error('SHAREPOINT_INGESTION_RETRY_AT_INVALID');
    }
    await this.dataSource.transaction(async (manager) => {
      await this.abandonStorage(manager, input.claim);
      const updated = mutationRows<{ state_version: number | string }>(
        await manager.query(
          `
            UPDATE ${this.ingestions}
            SET status = 'WAITING_RETRY',
                state_version = state_version + 1,
                next_attempt_at = $4,
                lease_owner = NULL,
                lease_expires_at = NULL,
                storage_object_id = NULL,
                failure_code = $5,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND lease_owner = $3
              AND lease_expires_at > clock_timestamp()
            RETURNING state_version
          `,
          [
            input.claim.tenantId,
            input.claim.ingestionId,
            input.leaseOwner,
            input.retryAt,
            input.failureCode,
          ],
        ),
      )[0];
      if (updated === undefined) {
        throw new Error('SHAREPOINT_INGESTION_LEASE_LOST');
      }
      await this.appendIngestionMessage(manager, {
        availableAt: input.retryAt,
        expectedStateVersion: Number(updated.state_version),
        ingestionId: input.claim.ingestionId,
        projectId: input.claim.projectId,
        tenantId: input.claim.tenantId,
      });
    });
  }

  async skip(
    input: Parameters<SharePointIngestionRepository['skip']>[0],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.abandonStorage(manager, input.claim);
      const updated = mutationRows<{ id: string }>(
        await manager.query(
          `
            UPDATE ${this.ingestions}
            SET status = 'SKIPPED',
                state_version = state_version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                failure_code = $4,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE tenant_id = $1
              AND id = $2
              AND lease_owner = $3
              AND lease_expires_at > clock_timestamp()
            RETURNING id
          `,
          [
            input.claim.tenantId,
            input.claim.ingestionId,
            input.leaseOwner,
            input.failureCode,
          ],
        ),
      );
      if (updated.length !== 1) {
        throw new Error('SHAREPOINT_INGESTION_LEASE_LOST');
      }
    });
  }

  private async abandonStorage(
    manager: EntityManager,
    claim: SharePointIngestionClaim,
  ): Promise<void> {
    await manager.query(
      `
        UPDATE ${this.storageObjects}
        SET status = 'ABANDONED',
            state_version = state_version + 1,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND status = 'RESERVED'
      `,
      [claim.tenantId, claim.storageObjectId],
    );
  }

  private async appendIngestionMessage(
    manager: EntityManager,
    input: {
      readonly availableAt: Date;
      readonly expectedStateVersion: number;
      readonly ingestionId: string;
      readonly projectId: string;
      readonly tenantId: string;
    },
  ): Promise<void> {
    const envelope = createMessageEnvelope({
      actor: { id: 'microsoft-sharepoint-ingest', type: 'SERVICE' },
      causationId: input.ingestionId,
      correlationId: input.ingestionId,
      data: {
        connectorId: 'microsoft-sharepoint',
        expectedStateVersion: input.expectedStateVersion,
        ingestionId: input.ingestionId,
      },
      occurredAt: input.availableAt,
      projectId: input.projectId,
      tenantId: input.tenantId,
      type: 'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
    });
    await this.outbox.append(queryRunner(manager), {
      aggregateId: input.ingestionId,
      aggregateType: 'DOCUMENT_INGESTION',
      availableAt: input.availableAt,
      envelope,
    });
  }
}
