import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3RuntimeConfig } from '@aiflow/config';

import { buildStorageObjectKey, isStorageObjectKey } from './key-policy';
import type {
  DeleteObjectInput,
  DirectUploadStoragePort,
  CompleteMultipartUploadInput,
  CompleteMultipartUploadResult,
  CreateMultipartPartCapabilityInput,
  CreateMultipartUploadInput,
  CreateSinglePutCapabilityInput,
  ObjectStoragePort,
  PutObjectInput,
  ReadObjectInput,
  UploadCapability,
} from './port';
import type {
  StorageChecksum,
  StorageChecksumType,
  StoredObjectMetadata,
} from './types';

const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const MAX_CAPABILITY_LIFETIME_SECONDS = 15 * 60;
const MAX_MULTIPART_PARTS = 10_000;

const assertLocation = (key: string, versionId?: string): void => {
  if (!isStorageObjectKey(key)) {
    throw new Error('STORAGE_OBJECT_KEY_INVALID');
  }
  if (
    versionId !== undefined &&
    (versionId.length === 0 || versionId.length > 1_024)
  ) {
    throw new Error('STORAGE_OBJECT_VERSION_INVALID');
  }
};

const assertChecksum = (checksum: StorageChecksum): void => {
  if (
    checksum.algorithm !== 'SHA256' ||
    !SHA256_BASE64_PATTERN.test(checksum.value)
  ) {
    throw new Error('STORAGE_CHECKSUM_INVALID');
  }
};

const assertPartChecksum = (value: string): void => {
  if (!SHA256_BASE64_PATTERN.test(value)) {
    throw new Error('STORAGE_PART_CHECKSUM_INVALID');
  }
};

const assertContentLength = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('STORAGE_CONTENT_LENGTH_INVALID');
  }
};

const assertContentType = (value: string): void => {
  if (
    value.trim().length === 0 ||
    value.length > 255 ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error('STORAGE_CONTENT_TYPE_INVALID');
  }
};

const assertCapabilityLifetime = (value: number): void => {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CAPABILITY_LIFETIME_SECONDS
  ) {
    throw new Error('STORAGE_CAPABILITY_LIFETIME_INVALID');
  }
};

const assertUploadReference = (value: string): void => {
  if (value.trim().length === 0 || value.length > 1_024) {
    throw new Error('STORAGE_MULTIPART_REFERENCE_INVALID');
  }
};

const requiredEncryptionHeaders = (
  config: S3RuntimeConfig,
): Readonly<Record<string, string>> => ({
  'x-amz-server-side-encryption': config.encryptionMode,
  ...(config.kmsKeyId === undefined
    ? {}
    : { 'x-amz-server-side-encryption-aws-kms-key-id': config.kmsKeyId }),
});

const compositeChecksum = (
  parts: readonly { readonly checksumValue: string }[],
): string => {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(Buffer.from(part.checksumValue, 'base64'));
  }
  return hash.digest('base64');
};

const isNotFound = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(candidate.name ?? '')
  );
};

const checksumType = (value: string | undefined): StorageChecksumType =>
  value === 'COMPOSITE' ? 'COMPOSITE' : 'FULL_OBJECT';

const metadataChecksum = (
  metadata: Record<string, string> | undefined,
): { type?: string; value?: string } => ({
  type: metadata?.['aiflow-checksum-type'],
  value: metadata?.['aiflow-checksum-sha256'],
});

const verifyingStream = (
  source: Readable,
  expectedChecksum: StorageChecksum,
): Readable => {
  const hash = createHash('sha256');
  const verifier = new Transform({
    flush(callback) {
      const actual = hash.digest('base64');
      callback(
        actual === expectedChecksum.value
          ? undefined
          : new Error('STORAGE_INTEGRITY_MISMATCH'),
      );
    },
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(undefined, chunk);
    },
  });
  return source.pipe(verifier);
};

export class S3ObjectStorage
  implements ObjectStoragePort, DirectUploadStoragePort
{
  private readonly client: S3Client;

  constructor(
    private readonly config: S3RuntimeConfig,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        forcePathStyle: config.forcePathStyle,
        region: config.region,
        requestHandler: { requestTimeout: config.requestTimeoutMs },
      });
  }

  async putImmutable(input: PutObjectInput): Promise<StoredObjectMetadata> {
    assertLocation(input.key);
    assertChecksum(input.checksum);
    if (input.checksum.type !== 'FULL_OBJECT') {
      throw new Error('STORAGE_SINGLE_PUT_CHECKSUM_TYPE_INVALID');
    }
    if (
      input.contentLength !== undefined &&
      (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0)
    ) {
      throw new Error('STORAGE_CONTENT_LENGTH_INVALID');
    }

    const response = await this.client.send(
      new PutObjectCommand({
        Body: input.stream,
        Bucket: this.config.bucket,
        ChecksumSHA256: input.checksum.value,
        ...(input.contentLength === undefined
          ? {}
          : { ContentLength: input.contentLength }),
        ContentType: input.contentType,
        IfNoneMatch: '*',
        Key: input.key,
        Metadata: {
          'aiflow-checksum-sha256': input.checksum.value,
          'aiflow-checksum-type': input.checksum.type,
        },
        ...(this.config.kmsKeyId === undefined
          ? {}
          : { SSEKMSKeyId: this.config.kmsKeyId }),
        ServerSideEncryption: this.config.encryptionMode,
      }),
    );
    if (response.VersionId === undefined || response.VersionId.length === 0) {
      throw new Error('STORAGE_VERSION_MISSING');
    }

    const metadata = await this.headExactVersion({
      key: input.key,
      versionId: response.VersionId,
    });
    if (metadata === undefined) {
      throw new Error('STORAGE_OBJECT_NOT_VISIBLE');
    }
    if (
      metadata.checksum.value !== input.checksum.value ||
      metadata.checksum.type !== input.checksum.type ||
      (input.contentLength !== undefined &&
        metadata.sizeBytes !== input.contentLength)
    ) {
      throw new Error('STORAGE_INTEGRITY_MISMATCH');
    }
    return metadata;
  }

  async createSinglePutCapability(
    input: CreateSinglePutCapabilityInput,
  ): Promise<UploadCapability> {
    const key = buildStorageObjectKey(input.tenantId, input.storageObjectId);
    assertChecksum({
      algorithm: 'SHA256',
      type: 'FULL_OBJECT',
      value: input.checksumValue,
    });
    assertContentLength(input.contentLength);
    assertContentType(input.contentType);
    assertCapabilityLifetime(input.expiresInSeconds);

    const issuedAt = new Date();
    const contentType = input.contentType.trim();
    const headers = {
      'content-type': contentType,
      'if-none-match': '*',
      'x-amz-checksum-sha256': input.checksumValue,
      'x-amz-meta-aiflow-checksum-sha256': input.checksumValue,
      'x-amz-meta-aiflow-checksum-type': 'FULL_OBJECT',
      ...requiredEncryptionHeaders(this.config),
    };
    const signedHeaders = new Set([
      'content-length',
      'content-type',
      'if-none-match',
      ...Object.keys(headers).filter((header) => header.startsWith('x-amz-')),
    ]);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        ChecksumSHA256: input.checksumValue,
        ContentLength: input.contentLength,
        ContentType: contentType,
        IfNoneMatch: '*',
        Key: key,
        Metadata: {
          'aiflow-checksum-sha256': input.checksumValue,
          'aiflow-checksum-type': 'FULL_OBJECT',
        },
        ...(this.config.kmsKeyId === undefined
          ? {}
          : { SSEKMSKeyId: this.config.kmsKeyId }),
        ServerSideEncryption: this.config.encryptionMode,
      }),
      {
        expiresIn: input.expiresInSeconds,
        signableHeaders: signedHeaders,
        signingDate: issuedAt,
        unhoistableHeaders: new Set(
          [...signedHeaders].filter((header) => header.startsWith('x-amz-')),
        ),
      },
    );

    return {
      expiresAt: new Date(issuedAt.getTime() + input.expiresInSeconds * 1_000),
      headers,
      method: 'PUT',
      url,
    };
  }

  async createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<{ readonly uploadReference: string }> {
    const key = buildStorageObjectKey(input.tenantId, input.storageObjectId);
    assertContentType(input.contentType);
    const contentType = input.contentType.trim();
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        ChecksumAlgorithm: 'SHA256',
        ChecksumType: 'COMPOSITE',
        ContentType: contentType,
        Key: key,
        Metadata: { 'aiflow-checksum-type': 'COMPOSITE' },
        ...(this.config.kmsKeyId === undefined
          ? {}
          : { SSEKMSKeyId: this.config.kmsKeyId }),
        ServerSideEncryption: this.config.encryptionMode,
      }),
    );
    if (response.UploadId === undefined || response.UploadId.length === 0) {
      throw new Error('STORAGE_MULTIPART_REFERENCE_MISSING');
    }
    return { uploadReference: response.UploadId };
  }

  async createMultipartPartCapability(
    input: CreateMultipartPartCapabilityInput,
  ): Promise<UploadCapability> {
    const key = buildStorageObjectKey(input.tenantId, input.storageObjectId);
    assertUploadReference(input.uploadReference);
    assertPartChecksum(input.checksumValue);
    assertContentLength(input.contentLength);
    assertCapabilityLifetime(input.expiresInSeconds);
    if (
      !Number.isInteger(input.partNumber) ||
      input.partNumber < 1 ||
      input.partNumber > MAX_MULTIPART_PARTS
    ) {
      throw new Error('STORAGE_MULTIPART_PART_NUMBER_INVALID');
    }

    const issuedAt = new Date();
    const headers = { 'x-amz-checksum-sha256': input.checksumValue };
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        ChecksumSHA256: input.checksumValue,
        ContentLength: input.contentLength,
        Key: key,
        PartNumber: input.partNumber,
        UploadId: input.uploadReference,
      }),
      {
        expiresIn: input.expiresInSeconds,
        signableHeaders: new Set(['content-length', 'x-amz-checksum-sha256']),
        signingDate: issuedAt,
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    );

    return {
      expiresAt: new Date(issuedAt.getTime() + input.expiresInSeconds * 1_000),
      headers,
      method: 'PUT',
      url,
    };
  }

  async completeMultipartUpload(
    input: CompleteMultipartUploadInput,
  ): Promise<CompleteMultipartUploadResult> {
    const key = buildStorageObjectKey(input.tenantId, input.storageObjectId);
    assertUploadReference(input.uploadReference);
    assertContentLength(input.sizeBytes);
    if (input.parts.length < 2 || input.parts.length > MAX_MULTIPART_PARTS) {
      throw new Error('STORAGE_MULTIPART_PARTS_INVALID');
    }
    input.parts.forEach((part, index) => {
      assertPartChecksum(part.checksumValue);
      if (
        part.partNumber !== index + 1 ||
        part.etag.trim().length === 0 ||
        part.etag.length > 1_024
      ) {
        throw new Error('STORAGE_MULTIPART_PARTS_INVALID');
      }
    });
    const expectedChecksum = compositeChecksum(input.parts);
    const response = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        ChecksumType: 'COMPOSITE',
        IfNoneMatch: '*',
        Key: key,
        MpuObjectSize: input.sizeBytes,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            ChecksumSHA256: part.checksumValue,
            ETag: part.etag,
            PartNumber: part.partNumber,
          })),
        },
        UploadId: input.uploadReference,
      }),
    );
    if (response.VersionId === undefined || response.VersionId.length === 0) {
      throw new Error('STORAGE_VERSION_MISSING');
    }
    if (
      response.ChecksumSHA256 !== undefined &&
      response.ChecksumSHA256 !== expectedChecksum
    ) {
      throw new Error('STORAGE_INTEGRITY_MISMATCH');
    }
    return {
      checksum: {
        algorithm: 'SHA256',
        type: 'COMPOSITE',
        value: expectedChecksum,
      },
      versionId: response.VersionId,
    };
  }

  async abortMultipartUpload(input: {
    readonly storageObjectId: string;
    readonly tenantId: string;
    readonly uploadReference: string;
  }): Promise<void> {
    const key = buildStorageObjectKey(input.tenantId, input.storageObjectId);
    assertUploadReference(input.uploadReference);
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: input.uploadReference,
      }),
    );
  }

  async headExactVersion(input: {
    key: string;
    versionId: string;
  }): Promise<StoredObjectMetadata | undefined> {
    assertLocation(input.key, input.versionId);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          ChecksumMode: 'ENABLED',
          Key: input.key,
          VersionId: input.versionId,
        }),
      );
      const fallback = metadataChecksum(response.Metadata);
      const checksumValue =
        response.ChecksumSHA256 ??
        (this.config.allowChecksumMetadataFallback
          ? fallback.value
          : undefined);
      const rawChecksumType =
        response.ChecksumType ??
        (this.config.allowChecksumMetadataFallback ? fallback.type : undefined);
      if (
        response.VersionId === undefined ||
        response.ContentLength === undefined ||
        checksumValue === undefined ||
        rawChecksumType === undefined
      ) {
        throw new Error('STORAGE_METADATA_INCOMPLETE');
      }

      return {
        checksum: {
          algorithm: 'SHA256',
          type: checksumType(rawChecksumType),
          value: checksumValue,
        },
        contentType: response.ContentType ?? 'application/octet-stream',
        ...(response.SSEKMSKeyId === undefined
          ? {}
          : { encryptionKeyRef: response.SSEKMSKeyId }),
        encryptionMode:
          response.ServerSideEncryption ?? this.config.encryptionMode,
        key: input.key,
        sizeBytes: response.ContentLength,
        versionId: response.VersionId,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async readExactVersion(input: ReadObjectInput): Promise<Readable> {
    assertLocation(input.key, input.versionId);
    assertChecksum(input.expectedChecksum);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ChecksumMode: 'ENABLED',
        Key: input.key,
        VersionId: input.versionId,
      }),
    );
    const fallback = metadataChecksum(response.Metadata);
    const checksumValue =
      response.ChecksumSHA256 ??
      (this.config.allowChecksumMetadataFallback ? fallback.value : undefined);
    const rawChecksumType =
      response.ChecksumType ??
      (this.config.allowChecksumMetadataFallback ? fallback.type : undefined);
    if (
      response.VersionId !== input.versionId ||
      checksumValue !== input.expectedChecksum.value ||
      checksumType(rawChecksumType) !== input.expectedChecksum.type
    ) {
      if (response.Body instanceof Readable) {
        response.Body.destroy();
      }
      throw new Error('STORAGE_INTEGRITY_MISMATCH');
    }
    if (!(response.Body instanceof Readable)) {
      throw new Error('STORAGE_BODY_UNAVAILABLE');
    }
    return input.expectedChecksum.type === 'FULL_OBJECT'
      ? verifyingStream(response.Body, input.expectedChecksum)
      : response.Body;
  }

  async deleteExactVersion(input: DeleteObjectInput): Promise<void> {
    assertLocation(input.key, input.versionId);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        VersionId: input.versionId,
      }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}
