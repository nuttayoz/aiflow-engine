import { randomUUID } from 'node:crypto';

import type { ObjectStoragePort, StoredObjectMetadata } from '@aiflow/storage';

import {
  SharePointGraphError,
  type SharePointGraphItem,
  type SharePointGraphPort,
} from './graph-port';

const DEFAULT_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const RETRY_DELAY_MS = 5_000;

export interface SharePointIngestionClaim {
  readonly bindingId: string;
  readonly connectionId: string;
  readonly driveId: string;
  readonly fileName: string;
  readonly ingestionId: string;
  readonly itemId: string;
  readonly projectId: string;
  readonly sourceVersion: string;
  readonly sourceVersionKind: 'CTAG' | 'ETAG';
  readonly storageKey: string;
  readonly storageObjectId: string;
  readonly tenantId: string;
}

export interface SharePointIngestionRepository {
  claim(input: {
    readonly consumerName: string;
    readonly expectedStateVersion: number;
    readonly ingestionId: string;
    readonly leaseDurationMs: number;
    readonly leaseOwner: string;
    readonly messageId: string;
    readonly messageType: string;
    readonly projectId: string;
    readonly tenantId: string;
  }): Promise<SharePointIngestionClaim | undefined>;
  complete(input: {
    readonly claim: SharePointIngestionClaim;
    readonly documentId: string;
    readonly executionId: string;
    readonly leaseOwner: string;
    readonly metadata: StoredObjectMetadata;
  }): Promise<void>;
  defer(input: {
    readonly claim: SharePointIngestionClaim;
    readonly failureCode: string;
    readonly leaseOwner: string;
    readonly retryAt: Date;
  }): Promise<void>;
  skip(input: {
    readonly claim: SharePointIngestionClaim;
    readonly failureCode: string;
    readonly leaseOwner: string;
  }): Promise<void>;
}

export type SharePointIngestionOutcome =
  'DEFERRED' | 'PROCESSED' | 'SKIPPED' | 'STALE';

const sourceVersion = (
  item: Extract<SharePointGraphItem, { kind: 'FILE' }>,
  kind: SharePointIngestionClaim['sourceVersionKind'],
): string | undefined => (kind === 'CTAG' ? item.cTag : item.eTag);

export class SharePointIngestionProcessor {
  constructor(
    private readonly repository: SharePointIngestionRepository,
    private readonly graph: SharePointGraphPort,
    private readonly storage: ObjectStoragePort,
    private readonly maximumDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(input: {
    readonly consumerName: string;
    readonly expectedStateVersion: number;
    readonly ingestionId: string;
    readonly leaseDurationMs: number;
    readonly leaseOwner: string;
    readonly messageId: string;
    readonly messageType: string;
    readonly projectId: string;
    readonly tenantId: string;
  }): Promise<SharePointIngestionOutcome> {
    const claim = await this.repository.claim(input);
    if (claim === undefined) return 'STALE';
    try {
      const before = await this.graph.getItem({
        connectionId: claim.connectionId,
        driveId: claim.driveId,
        itemId: claim.itemId,
        tenantId: claim.tenantId,
      });
      if (
        before?.kind !== 'FILE' ||
        sourceVersion(before, claim.sourceVersionKind) !== claim.sourceVersion
      ) {
        await this.repository.skip({
          claim,
          failureCode: 'SHAREPOINT_SOURCE_VERSION_CHANGED',
          leaseOwner: input.leaseOwner,
        });
        return 'SKIPPED';
      }
      if (
        before.sizeBytes <= 0 ||
        before.sizeBytes > this.maximumDocumentBytes
      ) {
        await this.repository.skip({
          claim,
          failureCode: 'SHAREPOINT_FILE_SIZE_UNSUPPORTED',
          leaseOwner: input.leaseOwner,
        });
        return 'SKIPPED';
      }
      let metadata = await this.storage.headCurrentVersion({
        key: claim.storageKey,
      });
      if (metadata !== undefined && metadata.sizeBytes !== before.sizeBytes) {
        await this.storage.deleteExactVersion({
          key: metadata.key,
          versionId: metadata.versionId,
        });
        metadata = undefined;
      }
      if (metadata === undefined) {
        const content = await this.graph.openFileContent({
          connectionId: claim.connectionId,
          driveId: claim.driveId,
          itemId: claim.itemId,
          tenantId: claim.tenantId,
        });
        if (
          content.contentLength !== before.sizeBytes ||
          content.contentLength > this.maximumDocumentBytes
        ) {
          throw new Error('SHAREPOINT_CONTENT_LENGTH_MISMATCH');
        }
        metadata = await this.storage.putImmutableStreaming({
          contentLength: content.contentLength,
          contentType: content.contentType,
          key: claim.storageKey,
          maximumBytes: this.maximumDocumentBytes,
          stream: content.stream,
        });
      }
      const after = await this.graph.getItem({
        connectionId: claim.connectionId,
        driveId: claim.driveId,
        itemId: claim.itemId,
        tenantId: claim.tenantId,
      });
      if (
        after?.kind !== 'FILE' ||
        sourceVersion(after, claim.sourceVersionKind) !== claim.sourceVersion
      ) {
        await this.storage.deleteExactVersion({
          key: metadata.key,
          versionId: metadata.versionId,
        });
        await this.repository.skip({
          claim,
          failureCode: 'SHAREPOINT_SOURCE_VERSION_CHANGED',
          leaseOwner: input.leaseOwner,
        });
        return 'SKIPPED';
      }
      await this.repository.complete({
        claim,
        documentId: randomUUID(),
        executionId: randomUUID(),
        leaseOwner: input.leaseOwner,
        metadata,
      });
      return 'PROCESSED';
    } catch (error) {
      if (
        error instanceof SharePointGraphError &&
        ![
          'GRAPH_OUTCOME_UNKNOWN',
          'GRAPH_THROTTLED',
          'GRAPH_UNAVAILABLE',
        ].includes(error.code)
      ) {
        throw error;
      }
      await this.repository.defer({
        claim,
        failureCode:
          error instanceof SharePointGraphError
            ? error.code
            : 'SHAREPOINT_INGESTION_TRANSIENT',
        leaseOwner: input.leaseOwner,
        retryAt:
          error instanceof SharePointGraphError && error.retryAt !== undefined
            ? error.retryAt
            : new Date(this.clock().getTime() + RETRY_DELAY_MS),
      });
      return 'DEFERRED';
    }
  }
}
