import type { DataSource } from 'typeorm';

import type {
  CreateStagedDocumentInput,
  DocumentRepository,
  StagedDocumentRecord,
} from '@aiflow/documents';

import { table } from './sql';

interface DocumentRow {
  checksum_algorithm: 'SHA256';
  checksum_value: string;
  content_type: string;
  created_at: Date | string;
  id: string;
  original_filename: string | null;
  project_id: string;
  size_bytes: number | string;
  source_connector_id: string;
  source_identity: string;
  source_storage_object_id: string;
  source_version: string;
  staged_at: Date | string;
  tenant_id: string;
}

const columns = `
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
  staged_at,
  created_at
`;

const mapDocument = (row: DocumentRow): StagedDocumentRecord => ({
  checksumAlgorithm: row.checksum_algorithm,
  checksumValue: row.checksum_value,
  contentType: row.content_type,
  createdAt: new Date(row.created_at),
  id: row.id,
  ...(row.original_filename === null
    ? {}
    : { originalFilename: row.original_filename }),
  projectId: row.project_id,
  sizeBytes: Number(row.size_bytes),
  sourceConnectorId: row.source_connector_id,
  sourceIdentity: row.source_identity,
  sourceStorageObjectId: row.source_storage_object_id,
  sourceVersion: row.source_version,
  stagedAt: new Date(row.staged_at),
  tenantId: row.tenant_id,
});

export class PostgresDocumentRepository implements DocumentRepository {
  private readonly documents: string;
  private readonly storageObjects: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.documents = table(schema, 'documents');
    this.storageObjects = table(schema, 'storage_objects');
  }

  async createStaged(
    input: CreateStagedDocumentInput,
  ): Promise<StagedDocumentRecord> {
    const rows = await this.dataSource.transaction(async (manager) =>
      manager.query(
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
          )
          SELECT
            $1,
            storage.tenant_id,
            storage.project_id,
            $4,
            $5,
            $6,
            storage.id,
            storage.size_bytes,
            storage.content_type,
            storage.checksum_algorithm,
            storage.checksum_value,
            $7,
            clock_timestamp()
          FROM ${this.storageObjects} AS storage
          WHERE storage.tenant_id = $2
            AND storage.project_id = $3
            AND storage.id = $8
            AND storage.status = 'AVAILABLE'
          RETURNING ${columns}
        `,
        [
          input.id,
          input.tenantId,
          input.projectId,
          input.sourceConnectorId,
          input.sourceIdentity,
          input.sourceVersion,
          input.originalFilename ?? null,
          input.sourceStorageObjectId,
        ],
      ),
    );
    const row = (rows as DocumentRow[])[0];
    if (row === undefined) {
      throw new Error('DOCUMENT_STORAGE_NOT_AVAILABLE');
    }

    return mapDocument(row);
  }

  async findById(
    tenantId: string,
    documentId: string,
  ): Promise<StagedDocumentRecord | undefined> {
    const rows = (await this.dataSource.query(
      `SELECT ${columns} FROM ${this.documents} WHERE tenant_id = $1 AND id = $2`,
      [tenantId, documentId],
    )) as DocumentRow[];

    return rows[0] === undefined ? undefined : mapDocument(rows[0]);
  }
}
