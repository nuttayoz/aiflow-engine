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

export interface UploadCapability {
  readonly expiresAt: Date;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'PUT';
  readonly url: string;
}

export interface CreateSinglePutCapabilityInput {
  readonly checksumValue: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly expiresInSeconds: number;
  readonly key: string;
}

export interface CreateMultipartUploadInput {
  readonly contentType: string;
  readonly key: string;
}

export interface CreateMultipartPartCapabilityInput {
  readonly checksumValue: string;
  readonly contentLength: number;
  readonly expiresInSeconds: number;
  readonly key: string;
  readonly partNumber: number;
  readonly uploadReference: string;
}

export interface MultipartPartReceipt {
  readonly checksumValue: string;
  readonly etag: string;
  readonly partNumber: number;
}

export interface CompleteMultipartUploadInput {
  readonly key: string;
  readonly parts: readonly MultipartPartReceipt[];
  readonly sizeBytes: number;
  readonly uploadReference: string;
}

export interface CompleteMultipartUploadResult {
  readonly checksum: StorageChecksum;
  readonly versionId: string;
}

export interface DirectUploadStoragePort {
  abortMultipartUpload(input: {
    readonly key: string;
    readonly uploadReference: string;
  }): Promise<void>;
  completeMultipartUpload(
    input: CompleteMultipartUploadInput,
  ): Promise<CompleteMultipartUploadResult>;
  createMultipartPartCapability(
    input: CreateMultipartPartCapabilityInput,
  ): Promise<UploadCapability>;
  createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<{ readonly uploadReference: string }>;
  createSinglePutCapability(
    input: CreateSinglePutCapabilityInput,
  ): Promise<UploadCapability>;
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
