import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  GetBucketEncryptionCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { loadS3RuntimeConfig } from '@aiflow/config';

import { buildStorageObjectKey } from './key-policy';
import { S3ObjectStorage } from './s3-object-storage';

const enabled = process.env.RUN_AWS_S3_CONTRACT === 'true';
const awsContract = enabled ? describe : describe.skip;

awsContract('real AWS S3 contract', () => {
  it('enforces target bucket controls and exact immutable object behavior', async () => {
    const bucket = process.env.AWS_S3_CONTRACT_BUCKET;
    const region = process.env.AWS_S3_CONTRACT_REGION;
    const kmsKeyId = process.env.AWS_S3_CONTRACT_KMS_KEY_ID;
    if (
      bucket === undefined ||
      region === undefined ||
      kmsKeyId === undefined
    ) {
      throw new Error('AWS_S3_CONTRACT_CONFIGURATION_REQUIRED');
    }
    const config = loadS3RuntimeConfig({
      NODE_ENV: 'production',
      S3_BUCKET: bucket,
      S3_KMS_KEY_ID: kmsKeyId,
      S3_REGION: region,
    });
    const client = new S3Client({ region });
    const storage = new S3ObjectStorage(config, client);

    const [versioning, publicAccess, ownership, encryption] = await Promise.all(
      [
        client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
        client.send(new GetPublicAccessBlockCommand({ Bucket: bucket })),
        client.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket })),
        client.send(new GetBucketEncryptionCommand({ Bucket: bucket })),
      ],
    );
    expect(versioning.Status).toBe('Enabled');
    expect(publicAccess.PublicAccessBlockConfiguration).toMatchObject({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(ownership.OwnershipControls?.Rules).toContainEqual({
      ObjectOwnership: 'BucketOwnerEnforced',
    });
    expect(encryption.ServerSideEncryptionConfiguration?.Rules).toContainEqual(
      expect.objectContaining({
        BucketKeyEnabled: true,
        ApplyServerSideEncryptionByDefault: expect.objectContaining({
          SSEAlgorithm: 'aws:kms',
        }),
      }),
    );

    const body = Buffer.from('aiflow-real-aws-contract');
    const checksum = {
      algorithm: 'SHA256' as const,
      type: 'FULL_OBJECT' as const,
      value: createHash('sha256').update(body).digest('base64'),
    };
    const key = buildStorageObjectKey(
      `aws-contract-${randomUUID()}`,
      randomUUID(),
    );
    let versionId: string | undefined;
    try {
      const metadata = await storage.putImmutable({
        checksum,
        contentLength: body.length,
        contentType: 'application/octet-stream',
        key,
        stream: Readable.from(body),
      });
      versionId = metadata.versionId;
      const stream = await storage.readExactVersion({
        expectedChecksum: checksum,
        key,
        versionId,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(body);
      await expect(
        storage.putImmutable({
          checksum,
          contentLength: body.length,
          contentType: 'application/octet-stream',
          key,
          stream: Readable.from(body),
        }),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    } finally {
      if (versionId !== undefined) {
        await storage.deleteExactVersion({ key, versionId });
      }
      storage.close();
    }
  });
});
