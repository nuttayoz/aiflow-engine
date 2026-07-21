import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  CreateBucketCommand,
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
});
