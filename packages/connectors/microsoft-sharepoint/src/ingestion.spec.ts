import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { ObjectStoragePort, StoredObjectMetadata } from '@aiflow/storage';

import {
  FakeSharePointGraphAdapter,
  type SharePointIngestionClaim,
  type SharePointIngestionRepository,
  SharePointIngestionProcessor,
} from './index';

const content = Buffer.from('sharepoint document');
const target = {
  connectionId: 'connection-1',
  driveId: 'drive-1',
  externalTenantId: 'external-tenant-1',
  folderId: 'folder-1',
  rootItemId: 'root-1',
  siteId: 'site-1',
};
const claim: SharePointIngestionClaim = {
  bindingId: 'binding-1',
  connectionId: target.connectionId,
  driveId: target.driveId,
  fileName: 'invoice.pdf',
  ingestionId: 'ingestion-1',
  itemId: 'file-1',
  projectId: 'project-1',
  sourceVersion: 'content-version-1',
  sourceVersionKind: 'CTAG',
  storageKey:
    'v1/t/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/o/11111111-1111-4111-8111-111111111111',
  storageObjectId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-1',
};

class IngestionRepository implements SharePointIngestionRepository {
  completed?: StoredObjectMetadata;
  deferred = false;
  skipped = false;

  async claim() {
    return claim;
  }

  async complete(
    input: Parameters<SharePointIngestionRepository['complete']>[0],
  ) {
    this.completed = input.metadata;
  }

  async defer() {
    this.deferred = true;
  }

  async skip() {
    this.skipped = true;
  }
}

const storageMetadata: StoredObjectMetadata = {
  checksum: {
    algorithm: 'SHA256',
    type: 'FULL_OBJECT',
    value: createHash('sha256').update(content).digest('base64'),
  },
  contentType: 'application/pdf',
  encryptionMode: 'AES256',
  key: claim.storageKey,
  sizeBytes: content.byteLength,
  versionId: 'version-1',
};

describe('SharePoint ingestion processor', () => {
  it('streams a stable source version into immutable storage', async () => {
    const repository = new IngestionRepository();
    const graph = new FakeSharePointGraphAdapter([target]);
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      finalCursor: 'cursor-1',
      items: [
        {
          cTag: claim.sourceVersion,
          contentType: 'application/pdf',
          eTag: 'etag-1',
          id: claim.itemId,
          kind: 'FILE',
          name: claim.fileName,
          parentId: target.folderId,
          sizeBytes: content.byteLength,
        },
      ],
    });
    graph.setFileContent(
      target.connectionId,
      target.driveId,
      claim.itemId,
      content,
    );
    const storage = {
      deleteExactVersion: jest.fn(),
      putImmutableStreaming: jest
        .fn()
        .mockImplementation(async (input: { stream: Readable }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of input.stream) {
            chunks.push(Buffer.from(chunk));
          }
          expect(Buffer.concat(chunks)).toEqual(content);
          return storageMetadata;
        }),
    } as unknown as ObjectStoragePort;

    await expect(
      new SharePointIngestionProcessor(repository, graph, storage).process({
        consumerName: 'ingest-worker',
        expectedStateVersion: 0,
        ingestionId: claim.ingestionId,
        leaseDurationMs: 30_000,
        leaseOwner: 'worker-1',
        messageId: 'message-1',
        messageType:
          'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
        projectId: claim.projectId,
        tenantId: claim.tenantId,
      }),
    ).resolves.toBe('PROCESSED');
    expect(repository.completed).toEqual(storageMetadata);
  });

  it('skips a changed source version before reading content', async () => {
    const repository = new IngestionRepository();
    const graph = new FakeSharePointGraphAdapter([target]);
    graph.setDeltaPage(target.connectionId, target.driveId, undefined, {
      finalCursor: 'cursor-1',
      items: [
        {
          cTag: 'content-version-2',
          eTag: 'etag-2',
          id: claim.itemId,
          kind: 'FILE',
          name: claim.fileName,
          parentId: target.folderId,
          sizeBytes: content.byteLength,
        },
      ],
    });

    await expect(
      new SharePointIngestionProcessor(
        repository,
        graph,
        {} as ObjectStoragePort,
      ).process({
        consumerName: 'ingest-worker',
        expectedStateVersion: 0,
        ingestionId: claim.ingestionId,
        leaseDurationMs: 30_000,
        leaseOwner: 'worker-1',
        messageId: 'message-1',
        messageType:
          'aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1',
        projectId: claim.projectId,
        tenantId: claim.tenantId,
      }),
    ).resolves.toBe('SKIPPED');
    expect(repository.skipped).toBe(true);
  });
});
