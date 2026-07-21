import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  GetObjectCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { buildStorageObjectKey } from './key-policy';
import { S3ObjectStorage } from './s3-object-storage';

const checksum = (value: Buffer): string =>
  createHash('sha256').update(value).digest('base64');

describe('S3 object storage contract', () => {
  let container: StartedTestContainer;
  let client: S3Client;
  let storage: S3ObjectStorage;
  const bucket = 'aiflow-contract-test';

  beforeAll(async () => {
    container = await new GenericContainer('motoserver/moto:5.2.2')
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forLogMessage(/Running on all addresses/u))
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(5000).toString()}`;
    client = new S3Client({
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      endpoint,
      forcePathStyle: true,
      region: 'us-east-1',
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    storage = new S3ObjectStorage(
      {
        allowChecksumMetadataFallback: true,
        bucket,
        encryptionMode: 'AES256',
        endpoint,
        forcePathStyle: true,
        region: 'us-east-1',
        requestTimeoutMs: 30_000,
      },
      client,
    );
  }, 120_000);

  afterAll(async () => {
    storage?.close();
    await container?.stop();
  });

  it('streams, verifies, prevents overwrite, and deletes the exact version', async () => {
    const body = Buffer.from('phase-one-storage-contract');
    const key = buildStorageObjectKey('tenant-a', randomUUID());
    const expectedChecksum = {
      algorithm: 'SHA256' as const,
      type: 'FULL_OBJECT' as const,
      value: checksum(body),
    };

    const stored = await storage.putImmutable({
      checksum: expectedChecksum,
      contentLength: body.length,
      contentType: 'application/pdf',
      key,
      stream: Readable.from([body.subarray(0, 8), body.subarray(8)]),
    });

    expect(stored).toMatchObject({
      checksum: expectedChecksum,
      contentType: 'application/pdf',
      key,
      sizeBytes: body.length,
    });
    expect(stored.versionId).not.toHaveLength(0);

    const stream = await storage.readExactVersion({
      expectedChecksum,
      key,
      versionId: stored.versionId,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(body);

    await expect(
      storage.putImmutable({
        checksum: expectedChecksum,
        contentLength: body.length,
        contentType: 'application/pdf',
        key,
        stream: Readable.from(body),
      }),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });

    await expect(
      storage.readExactVersion({
        expectedChecksum: {
          ...expectedChecksum,
          value: checksum(Buffer.from('different')),
        },
        key,
        versionId: stored.versionId,
      }),
    ).rejects.toThrow('STORAGE_INTEGRITY_MISMATCH');

    await storage.deleteExactVersion({ key, versionId: stored.versionId });
    await expect(
      storage.headExactVersion({ key, versionId: stored.versionId }),
    ).resolves.toBeUndefined();
  });

  it('issues a short-lived checksum-bound single PUT capability', async () => {
    const body = Buffer.from('phase-two-browser-upload');
    const storageObjectId = randomUUID();
    const tenantId = 'tenant-browser';
    const key = buildStorageObjectKey(tenantId, storageObjectId);
    const checksumValue = checksum(body);
    const capability = await storage.createSinglePutCapability({
      checksumValue,
      contentLength: body.length,
      contentType: 'application/pdf',
      expiresInSeconds: 60,
      storageObjectId,
      tenantId,
    });

    expect(capability).toMatchObject({
      headers: {
        'content-type': 'application/pdf',
        'if-none-match': '*',
        'x-amz-checksum-sha256': checksumValue,
        'x-amz-server-side-encryption': 'AES256',
      },
      method: 'PUT',
    });
    expect(capability.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const signedHeaders = new URL(capability.url).searchParams.get(
      'X-Amz-SignedHeaders',
    );
    expect(signedHeaders).toEqual(
      expect.stringContaining('x-amz-checksum-sha256'),
    );
    expect(signedHeaders).toEqual(expect.stringContaining('if-none-match'));

    const uploaded = await fetch(capability.url, {
      body,
      headers: capability.headers,
      method: capability.method,
    });
    expect(uploaded.status).toBe(200);
    const versionId = uploaded.headers.get('x-amz-version-id');
    expect(versionId).not.toBeNull();
    if (versionId === null) {
      throw new Error('TEST_VERSION_MISSING');
    }
    await expect(
      storage.headExactVersion({ key, versionId }),
    ).resolves.toMatchObject({
      checksum: {
        algorithm: 'SHA256',
        type: 'FULL_OBJECT',
        value: checksumValue,
      },
      sizeBytes: body.length,
    });
    await expect(
      storage.inspectUpload({ storageObjectId, tenantId }),
    ).resolves.toMatchObject({
      checksum: {
        algorithm: 'SHA256',
        type: 'FULL_OBJECT',
        value: checksumValue,
      },
      key,
      versionId,
    });

    const duplicate = await fetch(capability.url, {
      body,
      headers: capability.headers,
      method: capability.method,
    });
    expect(duplicate.status).toBe(412);
  });

  it('uploads consecutive checksum-bound parts and completes one version', async () => {
    const firstPart = Buffer.alloc(5 * 1024 * 1024, 1);
    const secondPart = Buffer.from('final-part');
    const parts = [firstPart, secondPart];
    const storageObjectId = randomUUID();
    const tenantId = 'tenant-multipart';
    const key = buildStorageObjectKey(tenantId, storageObjectId);
    const { uploadReference } = await storage.createMultipartUpload({
      contentType: 'application/pdf',
      storageObjectId,
      tenantId,
    });
    const receipts = [];

    for (const [index, body] of parts.entries()) {
      const checksumValue = checksum(body);
      const capability = await storage.createMultipartPartCapability({
        checksumValue,
        contentLength: body.length,
        expiresInSeconds: 60,
        storageObjectId,
        tenantId,
        partNumber: index + 1,
        uploadReference,
      });
      expect(
        new URL(capability.url).searchParams.get('X-Amz-SignedHeaders'),
      ).toEqual(expect.stringContaining('x-amz-checksum-sha256'));
      const uploaded = await fetch(capability.url, {
        body,
        headers: capability.headers,
        method: capability.method,
      });
      expect(uploaded.status).toBe(200);
      const etag = uploaded.headers.get('etag');
      if (etag === null) {
        throw new Error('TEST_MULTIPART_ETAG_MISSING');
      }
      receipts.push({ checksumValue, etag, partNumber: index + 1 });
    }

    const completed = await storage.completeMultipartUpload({
      parts: receipts,
      sizeBytes: firstPart.length + secondPart.length,
      storageObjectId,
      tenantId,
      uploadReference,
    });
    expect(completed).toMatchObject({
      checksum: { algorithm: 'SHA256', type: 'COMPOSITE' },
    });
    expect(completed.checksum.value).toMatch(/^[A-Za-z0-9+/]{43}=-2$/u);

    await expect(
      storage.headExactVersion({ key, versionId: completed.versionId }),
    ).resolves.toMatchObject({
      checksum: completed.checksum,
      sizeBytes: firstPart.length + secondPart.length,
    });
    await expect(
      storage.inspectUpload({
        storageObjectId,
        tenantId,
        versionId: completed.versionId,
      }),
    ).resolves.toMatchObject({
      checksum: completed.checksum,
      key,
      versionId: completed.versionId,
    });
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: completed.versionId,
      }),
    );
    if (response.Body === undefined) {
      throw new Error('TEST_MULTIPART_BODY_MISSING');
    }
    expect(Buffer.from(await response.Body.transformToByteArray())).toEqual(
      Buffer.concat(parts),
    );
  });

  it('aborts a multipart upload and rejects unsafe capability inputs', async () => {
    const storageObjectId = randomUUID();
    const tenantId = 'tenant-abort';
    const { uploadReference } = await storage.createMultipartUpload({
      contentType: 'application/pdf',
      storageObjectId,
      tenantId,
    });
    await storage.abortMultipartUpload({
      storageObjectId,
      tenantId,
      uploadReference,
    });

    const body = Buffer.from('aborted-part');
    const capability = await storage.createMultipartPartCapability({
      checksumValue: checksum(body),
      contentLength: body.length,
      expiresInSeconds: 60,
      storageObjectId,
      tenantId,
      partNumber: 1,
      uploadReference,
    });
    const upload = await fetch(capability.url, {
      body,
      headers: capability.headers,
      method: capability.method,
    });
    expect(upload.ok).toBe(false);

    await expect(
      storage.createSinglePutCapability({
        checksumValue: 'invalid',
        contentLength: body.length,
        contentType: 'application/pdf',
        expiresInSeconds: 60,
        storageObjectId,
        tenantId,
      }),
    ).rejects.toThrow('STORAGE_CHECKSUM_INVALID');
    await expect(
      storage.createMultipartPartCapability({
        checksumValue: checksum(body),
        contentLength: body.length,
        expiresInSeconds: 901,
        storageObjectId,
        tenantId,
        partNumber: 1,
        uploadReference,
      }),
    ).rejects.toThrow('STORAGE_CAPABILITY_LIFETIME_INVALID');
  });
});
