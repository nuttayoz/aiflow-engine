export const STORAGE_OBJECT_KINDS = [
  'SOURCE_DOCUMENT',
  'EXTRACTION_RESULT',
  'MAPPING_RESULT',
  'REVIEW_ARTIFACT',
  'DELIVERY_ARTIFACT',
] as const;
export const STORAGE_OBJECT_STATUSES = [
  'RESERVED',
  'AVAILABLE',
  'DELETE_PENDING',
  'DELETED',
  'ABANDONED',
] as const;

export type StorageObjectKind = (typeof STORAGE_OBJECT_KINDS)[number];
export type StorageObjectStatus = (typeof STORAGE_OBJECT_STATUSES)[number];
export type StorageChecksumType = 'COMPOSITE' | 'FULL_OBJECT';

export interface StorageChecksum {
  readonly algorithm: 'SHA256';
  readonly type: StorageChecksumType;
  readonly value: string;
}

export interface StorageObjectLocation {
  readonly key: string;
  readonly locationAlias: string;
  readonly versionId: string;
}

export interface StorageObjectRecord {
  readonly availableAt?: Date;
  readonly checksum?: StorageChecksum;
  readonly contentType?: string;
  readonly encryptionKeyRef?: string;
  readonly encryptionMode?: string;
  readonly id: string;
  readonly kind: StorageObjectKind;
  readonly location: Omit<StorageObjectLocation, 'versionId'> & {
    readonly versionId?: string;
  };
  readonly projectId: string;
  readonly reservedAt: Date;
  readonly retentionUntil: Date;
  readonly sizeBytes?: number;
  readonly stateVersion: number;
  readonly status: StorageObjectStatus;
  readonly tenantId: string;
}

export interface StoredObjectMetadata {
  readonly checksum: StorageChecksum;
  readonly contentType: string;
  readonly encryptionKeyRef?: string;
  readonly encryptionMode: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly versionId: string;
}
