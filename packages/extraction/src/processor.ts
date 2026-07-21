import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type {
  ClaimedExecutionStage,
  ExecutionRepository,
} from '@aiflow/executions';
import {
  buildStorageObjectKey,
  type DirectUploadStoragePort,
  type ObjectStoragePort,
  type StoredObjectMetadata,
} from '@aiflow/storage';

import {
  encodeCanonicalExtractionResult,
  ExtractionProviderError,
  type ExtractionProfileCatalog,
  type ExtractionProviderPort,
  validateCanonicalExtractionResult,
} from './index';

interface ExtractionWorkContext {
  readonly contentSha256: string;
  readonly executionId: string;
  readonly profileVersionId: string;
  readonly projectId: string;
  readonly source: {
    readonly checksum: {
      readonly algorithm: 'SHA256';
      readonly type: 'COMPOSITE' | 'FULL_OBJECT';
      readonly value: string;
    };
    readonly key: string;
    readonly sizeBytes: number;
    readonly versionId: string;
  };
  readonly tenantId: string;
  readonly workflowDefinition: {
    readonly extraction: { readonly profileId: string };
  };
}

interface ExtractionArtifact {
  readonly storageObjectId: string;
}

interface ExtractionRequest {
  readonly deadlineAt: Date;
  readonly id: string;
  readonly providerOperationRef?: string;
  readonly status:
    'ACCEPTED' | 'COMPLETED' | 'FAILED' | 'RESULT_AVAILABLE' | 'SUBMITTING';
}

export interface ExtractionProcessingRepository {
  completeExtraction(input: {
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly metadata: StoredObjectMetadata;
    readonly requestId: string;
    readonly tenantId: string;
  }): Promise<void>;
  loadWorkContext(
    tenantId: string,
    executionId: string,
  ): Promise<ExtractionWorkContext | undefined>;
  markExtractionResultAvailable(
    tenantId: string,
    requestId: string,
  ): Promise<void>;
  prepareExtraction(input: {
    readonly adapterId: string;
    readonly callbackCorrelationId: string;
    readonly deadlineAt: Date;
    readonly executionId: string;
    readonly extractionRequestId: string;
    readonly leaseOwner: string;
    readonly nextCheckAt: Date;
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly projectId: string;
    readonly resultStorageObjectId: string;
    readonly retentionUntil: Date;
    readonly stageAttemptId: string;
    readonly tenantId: string;
  }): Promise<{
    readonly artifact: ExtractionArtifact;
    readonly request: ExtractionRequest;
  }>;
  recordExtractionAccepted(input: {
    readonly nextCheckAt: Date;
    readonly providerOperationRef: string;
    readonly requestId: string;
    readonly tenantId: string;
  }): Promise<ExtractionRequest>;
}

type ExtractionStoragePort = ObjectStoragePort & DirectUploadStoragePort;

type Clock = () => Date;
type IdGenerator = () => string;

export class ExtractionProcessor {
  constructor(
    private readonly repository: ExtractionProcessingRepository,
    private readonly executions: ExecutionRepository,
    private readonly storage: ExtractionStoragePort,
    private readonly provider: ExtractionProviderPort,
    private readonly profiles: ExtractionProfileCatalog,
    private readonly clock: Clock = () => new Date(),
    private readonly generateId: IdGenerator = randomUUID,
  ) {}

  async process(
    claimed: ClaimedExecutionStage,
    causationId: string,
  ): Promise<'COMPLETED' | 'FAILED' | 'WAITING'> {
    const context = await this.repository.loadWorkContext(
      claimed.execution.tenantId,
      claimed.execution.executionId,
    );
    if (context === undefined) {
      throw new Error('EXTRACTION_CONTEXT_NOT_FOUND');
    }
    const profile = this.profiles.find(
      context.workflowDefinition.extraction.profileId,
    );
    if (
      profile === undefined ||
      profile.profileVersionId !== context.profileVersionId
    ) {
      return this.fail(
        claimed,
        'EXTRACTION_PROFILE_NOT_AVAILABLE',
        'The frozen extraction profile is not available.',
      );
    }
    const now = this.clock();
    const prepared = await this.repository.prepareExtraction({
      adapterId: 'fake-extraction',
      callbackCorrelationId: this.generateId(),
      deadlineAt: new Date(now.getTime() + 30 * 60 * 1_000),
      executionId: context.executionId,
      extractionRequestId: this.generateId(),
      leaseOwner: claimed.attempt.leaseOwner,
      nextCheckAt: now,
      profileId: profile.profileId,
      profileVersionId: profile.profileVersionId,
      projectId: context.projectId,
      resultStorageObjectId: this.generateId(),
      retentionUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      stageAttemptId: claimed.attempt.attemptId,
      tenantId: context.tenantId,
    });
    let request = prepared.request;

    try {
      if (
        request.providerOperationRef === undefined &&
        request.status === 'SUBMITTING'
      ) {
        const source = await this.storage.readExactVersion({
          expectedChecksum: context.source.checksum,
          key: context.source.key,
          versionId: context.source.versionId,
        });
        try {
          const submitted = await this.provider.submit({
            expectedContentSha256: context.contentSha256,
            expectedSizeBytes: context.source.sizeBytes,
            profileId: profile.profileId,
            profileVersionId: profile.profileVersionId,
            source,
            submissionKey: request.id,
          });
          request = await this.repository.recordExtractionAccepted({
            nextCheckAt: new Date(this.clock().getTime() + 1_000),
            providerOperationRef: submitted.providerOperationRef,
            requestId: request.id,
            tenantId: context.tenantId,
          });
        } catch (error) {
          source.destroy();
          if (
            error instanceof ExtractionProviderError &&
            error.code === 'EXTRACTION_THROTTLED'
          ) {
            await this.scheduleRetry(
              claimed,
              error.retryAfter ?? new Date(this.clock().getTime() + 1_000),
              'EXTRACTION_THROTTLED',
            );
            return 'WAITING';
          }
          if (
            !(error instanceof ExtractionProviderError) ||
            error.code !== 'EXTRACTION_OUTCOME_UNKNOWN'
          ) {
            throw error;
          }
        }
      }

      const inspection = await this.provider.inspect({
        providerOperationRef: request.providerOperationRef,
        submissionKey: request.id,
      });
      if (inspection.status === 'PENDING') {
        await this.scheduleRetry(
          claimed,
          inspection.retryAfter ?? new Date(this.clock().getTime() + 1_000),
          'EXTRACTION_PENDING',
        );
        return 'WAITING';
      }
      if (inspection.status === 'NOT_FOUND') {
        if (this.clock().getTime() >= request.deadlineAt.getTime()) {
          return this.fail(
            claimed,
            'EXTRACTION_OUTCOME_UNKNOWN',
            'The extraction result could not be confirmed.',
            'UNKNOWN_OUTCOME',
          );
        }
        await this.scheduleRetry(
          claimed,
          new Date(this.clock().getTime() + 1_000),
          'EXTRACTION_RECONCILING',
        );
        return 'WAITING';
      }
      if (inspection.status === 'FAILED') {
        return this.fail(
          claimed,
          inspection.failureCode,
          'The extraction provider rejected the document.',
        );
      }

      await this.repository.markExtractionResultAvailable(
        context.tenantId,
        request.id,
      );
      const untrusted = await this.provider.fetchResult({
        providerOperationRef: request.providerOperationRef,
        submissionKey: request.id,
      });
      const result = validateCanonicalExtractionResult(untrusted, {
        contentSha256: context.contentSha256,
        outputFields: profile.outputFields,
        profileId: profile.profileId,
        profileVersionId: profile.profileVersionId,
        sizeBytes: context.source.sizeBytes,
      });
      const encoded = encodeCanonicalExtractionResult(result);
      const checksum = createHash('sha256').update(encoded).digest('base64');
      const metadata = await this.writeOrInspect(
        context.tenantId,
        prepared.artifact.storageObjectId,
        encoded,
        checksum,
      );
      await this.repository.completeExtraction({
        causationId,
        executionId: context.executionId,
        expectedStateVersion: claimed.execution.stateVersion,
        leaseOwner: claimed.attempt.leaseOwner,
        metadata,
        requestId: request.id,
        tenantId: context.tenantId,
      });
      return 'COMPLETED';
    } catch (error) {
      const code =
        error instanceof Error &&
        ['EXTRACTION_RESULT_INVALID', 'EXTRACTION_RESULT_TOO_LARGE'].includes(
          error.message,
        )
          ? error.message
          : undefined;
      if (code !== undefined) {
        return this.fail(
          claimed,
          code,
          'The extraction result did not satisfy the frozen profile.',
        );
      }
      throw error;
    }
  }

  private async writeOrInspect(
    tenantId: string,
    storageObjectId: string,
    encoded: Buffer,
    checksumValue: string,
  ): Promise<StoredObjectMetadata> {
    const current = await this.storage.inspectUpload({
      storageObjectId,
      tenantId,
    });
    if (current !== undefined) {
      if (
        current.sizeBytes !== encoded.length ||
        current.contentType !== 'application/json' ||
        current.checksum.type !== 'FULL_OBJECT' ||
        current.checksum.value !== checksumValue
      ) {
        throw new Error('EXTRACTION_ARTIFACT_CONFLICT');
      }
      return current;
    }
    return this.storage.putImmutable({
      checksum: {
        algorithm: 'SHA256',
        type: 'FULL_OBJECT',
        value: checksumValue,
      },
      contentLength: encoded.length,
      contentType: 'application/json',
      key: buildStorageObjectKey(tenantId, storageObjectId),
      stream: Readable.from(encoded),
    });
  }

  private async scheduleRetry(
    claimed: ClaimedExecutionStage,
    nextAttemptAt: Date,
    code: string,
  ): Promise<void> {
    const bounded = new Date(
      Math.max(nextAttemptAt.getTime(), this.clock().getTime() + 100),
    );
    await this.executions.scheduleRetry({
      executionId: claimed.execution.executionId,
      expectedStateVersion: claimed.execution.stateVersion,
      failure: {
        category: 'TRANSIENT',
        code,
        message: 'Extraction will be retried after a bounded delay.',
        retryable: true,
      },
      leaseOwner: claimed.attempt.leaseOwner,
      nextAttemptAt: bounded,
      stage: 'EXTRACT',
      tenantId: claimed.execution.tenantId,
    });
  }

  private async fail(
    claimed: ClaimedExecutionStage,
    code: string,
    message: string,
    category: 'PERMANENT' | 'UNKNOWN_OUTCOME' = 'PERMANENT',
  ): Promise<'FAILED'> {
    await this.executions.failStage({
      executionId: claimed.execution.executionId,
      expectedStateVersion: claimed.execution.stateVersion,
      failure: { category, code, message, retryable: false },
      leaseOwner: claimed.attempt.leaseOwner,
      stage: 'EXTRACT',
      tenantId: claimed.execution.tenantId,
    });
    return 'FAILED';
  }
}
