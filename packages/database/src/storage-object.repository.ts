import type { DataSource } from 'typeorm';

import {
  buildStorageObjectKey,
  type MakeStorageObjectAvailableInput,
  type ReserveStorageObjectInput,
  type StorageObjectRecord,
  type StorageObjectRepository,
} from '@aiflow/storage';

import { mutationRows, table } from './sql';

interface StorageObjectRow {
  available_at: Date | string | null;
  checksum_algorithm: 'SHA256' | null;
  checksum_type: 'COMPOSITE' | 'FULL_OBJECT' | null;
  checksum_value: string | null;
  content_type: string | null;
  encryption_key_ref: string | null;
  encryption_mode: string | null;
  id: string;
  kind: StorageObjectRecord['kind'];
  location_alias: string;
  object_key: string;
  project_id: string;
  reserved_at: Date | string;
  retention_until: Date | string;
  size_bytes: number | string | null;
  state_version: number | string;
  status: StorageObjectRecord['status'];
  tenant_id: string;
  version_id: string | null;
}

const mapStorageObject = (row: StorageObjectRow): StorageObjectRecord => ({
  ...(row.available_at === null
    ? {}
    : { availableAt: new Date(row.available_at) }),
  ...(row.checksum_algorithm === null ||
  row.checksum_type === null ||
  row.checksum_value === null
    ? {}
    : {
        checksum: {
          algorithm: row.checksum_algorithm,
          type: row.checksum_type,
          value: row.checksum_value,
        },
      }),
  ...(row.content_type === null ? {} : { contentType: row.content_type }),
  ...(row.encryption_key_ref === null
    ? {}
    : { encryptionKeyRef: row.encryption_key_ref }),
  ...(row.encryption_mode === null
    ? {}
    : { encryptionMode: row.encryption_mode }),
  id: row.id,
  kind: row.kind,
  location: {
    key: row.object_key,
    locationAlias: row.location_alias,
    ...(row.version_id === null ? {} : { versionId: row.version_id }),
  },
  projectId: row.project_id,
  reservedAt: new Date(row.reserved_at),
  retentionUntil: new Date(row.retention_until),
  ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
  stateVersion: Number(row.state_version),
  status: row.status,
  tenantId: row.tenant_id,
});

const returningColumns = `
  id,
  tenant_id,
  project_id,
  kind,
  status,
  state_version,
  location_alias,
  object_key,
  version_id,
  size_bytes,
  content_type,
  checksum_algorithm,
  checksum_type,
  checksum_value,
  encryption_mode,
  encryption_key_ref,
  retention_until,
  reserved_at,
  available_at
`;

export class PostgresStorageObjectRepository implements StorageObjectRepository {
  private readonly storageObjects: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.storageObjects = table(schema, 'storage_objects');
  }

  async reserve(
    input: ReserveStorageObjectInput,
  ): Promise<StorageObjectRecord> {
    if (input.retentionUntil.getTime() <= Date.now()) {
      throw new Error('STORAGE_RETENTION_INVALID');
    }
    const key = buildStorageObjectKey(input.tenantId, input.id);
    const rows = mutationRows<StorageObjectRow>(
      await this.dataSource.query(
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
        RETURNING ${returningColumns}
      `,
        [
          input.id,
          input.tenantId,
          input.projectId,
          input.kind,
          key,
          input.retentionUntil,
        ],
      ),
    );

    return mapStorageObject(rows[0]);
  }

  async markAvailable(
    input: MakeStorageObjectAvailableInput,
  ): Promise<StorageObjectRecord> {
    const rows = mutationRows<StorageObjectRow>(
      await this.dataSource.query(
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
          AND state_version = $3
          AND status = 'RESERVED'
          AND object_key = $12
        RETURNING ${returningColumns}
      `,
        [
          input.tenantId,
          input.id,
          input.expectedStateVersion,
          input.metadata.versionId,
          input.metadata.sizeBytes,
          input.metadata.contentType,
          input.metadata.checksum.algorithm,
          input.metadata.checksum.type,
          input.metadata.checksum.value,
          input.metadata.encryptionMode,
          input.metadata.encryptionKeyRef ?? null,
          input.metadata.key,
        ],
      ),
    );
    if (rows[0] === undefined) {
      throw new Error('STORAGE_OBJECT_TRANSITION_CONFLICT');
    }

    return mapStorageObject(rows[0]);
  }

  async markDeletePending(
    tenantId: string,
    storageObjectId: string,
    expectedStateVersion: number,
  ): Promise<StorageObjectRecord> {
    return this.transition(
      tenantId,
      storageObjectId,
      expectedStateVersion,
      "status = 'DELETE_PENDING', delete_attempt_at = clock_timestamp()",
      ['AVAILABLE', 'ABANDONED'],
    );
  }

  async markDeleted(
    tenantId: string,
    storageObjectId: string,
    expectedStateVersion: number,
  ): Promise<StorageObjectRecord> {
    return this.transition(
      tenantId,
      storageObjectId,
      expectedStateVersion,
      "status = 'DELETED', deleted_at = clock_timestamp()",
      ['DELETE_PENDING'],
    );
  }

  async findById(
    tenantId: string,
    storageObjectId: string,
  ): Promise<StorageObjectRecord | undefined> {
    const rows = mutationRows<StorageObjectRow>(
      await this.dataSource.query(
        `
        SELECT ${returningColumns}
        FROM ${this.storageObjects}
        WHERE tenant_id = $1 AND id = $2
      `,
        [tenantId, storageObjectId],
      ),
    );

    return rows[0] === undefined ? undefined : mapStorageObject(rows[0]);
  }

  private async transition(
    tenantId: string,
    storageObjectId: string,
    expectedStateVersion: number,
    assignment: string,
    allowedStatuses: readonly string[],
  ): Promise<StorageObjectRecord> {
    const rows = (await this.dataSource.query(
      `
        UPDATE ${this.storageObjects}
        SET ${assignment},
            state_version = state_version + 1,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1
          AND id = $2
          AND state_version = $3
          AND status = ANY($4::text[])
        RETURNING ${returningColumns}
      `,
      [tenantId, storageObjectId, expectedStateVersion, allowedStatuses],
    )) as StorageObjectRow[];
    if (rows[0] === undefined) {
      throw new Error('STORAGE_OBJECT_TRANSITION_CONFLICT');
    }

    return mapStorageObject(rows[0]);
  }
}
