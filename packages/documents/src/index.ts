export interface StagedDocumentRecord {
  readonly checksumAlgorithm: 'SHA256';
  readonly checksumValue: string;
  readonly contentType: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly originalFilename?: string;
  readonly projectId: string;
  readonly sizeBytes: number;
  readonly sourceConnectorId: string;
  readonly sourceIdentity: string;
  readonly sourceStorageObjectId: string;
  readonly sourceVersion: string;
  readonly stagedAt: Date;
  readonly tenantId: string;
}

export interface CreateStagedDocumentInput {
  readonly id: string;
  readonly originalFilename?: string;
  readonly projectId: string;
  readonly sourceConnectorId: string;
  readonly sourceIdentity: string;
  readonly sourceStorageObjectId: string;
  readonly sourceVersion: string;
  readonly tenantId: string;
}

export interface DocumentRepository {
  createStaged(input: CreateStagedDocumentInput): Promise<StagedDocumentRecord>;
  findById(
    tenantId: string,
    documentId: string,
  ): Promise<StagedDocumentRecord | undefined>;
}
