import type { Readable } from 'node:stream';

import type {
  StorageChecksum,
  StorageObjectKind,
  StorageObjectRecord,
  StoredObjectMetadata,
} from './types';

export interface PutObjectInput {
  readonly checksum: StorageChecksum;
  readonly contentLength?: number;
  readonly contentType: string;
  readonly key: string;
  readonly stream: Readable;
}

export interface ReadObjectInput {
  readonly expectedChecksum: StorageChecksum;
  readonly key: string;
  readonly versionId: string;
}

export interface DeleteObjectInput {
  readonly key: string;
  readonly versionId: string;
}

export interface ObjectStoragePort {
  deleteExactVersion(input: DeleteObjectInput): Promise<void>;
  headExactVersion(input: {
    key: string;
    versionId: string;
  }): Promise<StoredObjectMetadata | undefined>;
  putImmutable(input: PutObjectInput): Promise<StoredObjectMetadata>;
  readExactVersion(input: ReadObjectInput): Promise<Readable>;
}

export interface ReserveStorageObjectInput {
  readonly id: string;
  readonly kind: StorageObjectKind;
  readonly projectId: string;
  readonly retentionUntil: Date;
  readonly tenantId: string;
}

export interface MakeStorageObjectAvailableInput {
  readonly expectedStateVersion: number;
  readonly id: string;
  readonly metadata: StoredObjectMetadata;
  readonly tenantId: string;
}

export interface StorageObjectRepository {
  findById(
    tenantId: string,
    storageObjectId: string,
  ): Promise<StorageObjectRecord | undefined>;
  markAvailable(
    input: MakeStorageObjectAvailableInput,
  ): Promise<StorageObjectRecord>;
  markDeleted(
    tenantId: string,
    storageObjectId: string,
    expectedStateVersion: number,
  ): Promise<StorageObjectRecord>;
  markDeletePending(
    tenantId: string,
    storageObjectId: string,
    expectedStateVersion: number,
  ): Promise<StorageObjectRecord>;
  reserve(input: ReserveStorageObjectInput): Promise<StorageObjectRecord>;
}
