import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { S3RuntimeConfig } from '@aiflow/config';

import { isStorageObjectKey } from './key-policy';
import type {
  DeleteObjectInput,
  ObjectStoragePort,
  PutObjectInput,
  ReadObjectInput,
} from './port';
import type {
  StorageChecksum,
  StorageChecksumType,
  StoredObjectMetadata,
} from './types';

const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;

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

export class S3ObjectStorage implements ObjectStoragePort {
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
    return verifyingStream(response.Body, input.expectedChecksum);
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
