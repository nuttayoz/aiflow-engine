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
  applyMappings,
  encodeCanonicalMapping,
  type MappingRule,
} from './index';

interface MappingWorkContext {
  readonly executionId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly workflowDefinition: {
    readonly destination: {
      readonly actionId: string;
      readonly config: Readonly<Record<string, unknown>>;
      readonly connectorId: string;
    };
    readonly mappings: readonly MappingRule[];
    readonly reviewPolicy: { readonly required: boolean };
  };
}

interface AvailableArtifact {
  readonly metadata?: StoredObjectMetadata;
  readonly storageObjectId: string;
}

export interface MappingProcessingRepository {
  completeMapping(input: {
    readonly actionId: string;
    readonly actionVersion: number;
    readonly causationId: string;
    readonly companyResourceId: string;
    readonly connectorId: string;
    readonly deliveryOperationId: string;
    readonly effectKey: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly metadata: StoredObjectMetadata;
    readonly payloadSha256: string;
    readonly reconciliationDeadlineAt: Date;
    readonly tenantId: string;
  }): Promise<void>;
  findArtifact(
    tenantId: string,
    executionId: string,
    stage: 'EXTRACT' | 'MAP',
  ): Promise<AvailableArtifact | undefined>;
  loadWorkContext(
    tenantId: string,
    executionId: string,
  ): Promise<MappingWorkContext | undefined>;
  prepareMappingArtifact(input: {
    readonly executionId: string;
    readonly leaseOwner: string;
    readonly projectId: string;
    readonly retentionUntil: Date;
    readonly stageAttemptId: string;
    readonly storageObjectId: string;
    readonly tenantId: string;
  }): Promise<AvailableArtifact>;
}

export interface DestinationPayloadValidator {
  validate(input: {
    readonly actionId: string;
    readonly connectorId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): { readonly actionVersion: number; readonly valid: boolean };
}

type MappingStoragePort = ObjectStoragePort & DirectUploadStoragePort;
type Clock = () => Date;
type IdGenerator = () => string;

const readBoundedJson = async (
  stream: Readable,
  maximumBytes = 64 * 1024 * 1024,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    size += chunk.length;
    if (size > maximumBytes) {
      stream.destroy();
      throw new Error('PROCESSING_ARTIFACT_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('PROCESSING_ARTIFACT_INVALID');
  }
};

const extractionData = (value: unknown): Readonly<Record<string, unknown>> => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 1
  ) {
    throw new Error('EXTRACTION_ARTIFACT_INVALID');
  }
  const data = (value as Record<string, unknown>).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('EXTRACTION_ARTIFACT_INVALID');
  }
  return data as Readonly<Record<string, unknown>>;
};

export class MappingProcessor {
  constructor(
    private readonly repository: MappingProcessingRepository,
    private readonly executions: ExecutionRepository,
    private readonly storage: MappingStoragePort,
    private readonly destinations: DestinationPayloadValidator,
    private readonly clock: Clock = () => new Date(),
    private readonly generateId: IdGenerator = randomUUID,
  ) {}

  async process(
    claimed: ClaimedExecutionStage,
    causationId: string,
  ): Promise<'COMPLETED' | 'FAILED'> {
    try {
      const context = await this.repository.loadWorkContext(
        claimed.execution.tenantId,
        claimed.execution.executionId,
      );
      if (context === undefined) {
        throw new Error('MAPPING_CONTEXT_NOT_FOUND');
      }
      if (context.workflowDefinition.reviewPolicy.required) {
        return this.fail(
          claimed,
          'REVIEW_NOT_SUPPORTED_IN_PHASE_2',
          'This Phase 2 workflow cannot require review.',
        );
      }
      const extraction = await this.repository.findArtifact(
        context.tenantId,
        context.executionId,
        'EXTRACT',
      );
      if (extraction?.metadata === undefined) {
        throw new Error('EXTRACTION_ARTIFACT_NOT_AVAILABLE');
      }
      const source = await this.storage.readExactVersion({
        expectedChecksum: extraction.metadata.checksum,
        key: extraction.metadata.key,
        versionId: extraction.metadata.versionId,
      });
      const data = extractionData(await readBoundedJson(source));
      const mapped = applyMappings(data, context.workflowDefinition.mappings);
      const target = context.workflowDefinition.destination;
      const validation = this.destinations.validate({
        actionId: target.actionId,
        connectorId: target.connectorId,
        payload: mapped.payload,
      });
      const companyResourceId = target.config.companyId;
      if (
        !validation.valid ||
        typeof companyResourceId !== 'string' ||
        companyResourceId.length === 0 ||
        companyResourceId.length > 180
      ) {
        return this.fail(
          claimed,
          'DESTINATION_INPUT_INVALID',
          'The mapped result does not satisfy the destination action.',
        );
      }
      const artifact = await this.repository.prepareMappingArtifact({
        executionId: context.executionId,
        leaseOwner: claimed.attempt.leaseOwner,
        projectId: context.projectId,
        retentionUntil: new Date(
          this.clock().getTime() + 30 * 24 * 60 * 60 * 1_000,
        ),
        stageAttemptId: claimed.attempt.attemptId,
        storageObjectId: this.generateId(),
        tenantId: context.tenantId,
      });
      const encoded = encodeCanonicalMapping(mapped);
      const checksumValue = createHash('sha256')
        .update(encoded)
        .digest('base64');
      const metadata = await this.writeOrInspect(
        context.tenantId,
        artifact.storageObjectId,
        encoded,
        checksumValue,
      );
      await this.repository.completeMapping({
        actionId: target.actionId,
        actionVersion: validation.actionVersion,
        causationId,
        companyResourceId,
        connectorId: target.connectorId,
        deliveryOperationId: this.generateId(),
        effectKey: this.generateId(),
        executionId: context.executionId,
        expectedStateVersion: claimed.execution.stateVersion,
        leaseOwner: claimed.attempt.leaseOwner,
        metadata,
        payloadSha256: mapped.payloadSha256,
        reconciliationDeadlineAt: new Date(
          this.clock().getTime() + 15 * 60 * 1_000,
        ),
        tenantId: context.tenantId,
      });
      return 'COMPLETED';
    } catch (error) {
      const permanentCodes = [
        'DESTINATION_INPUT_INVALID',
        'EXTRACTION_ARTIFACT_INVALID',
        'MAPPING_INVALID',
        'MAPPING_REQUIRED_VALUE_MISSING',
        'PROCESSING_ARTIFACT_INVALID',
        'PROCESSING_ARTIFACT_TOO_LARGE',
      ];
      if (error instanceof Error && permanentCodes.includes(error.message)) {
        return this.fail(
          claimed,
          error.message,
          'The document could not be mapped to the destination action.',
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
        throw new Error('MAPPING_ARTIFACT_CONFLICT');
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

  private async fail(
    claimed: ClaimedExecutionStage,
    code: string,
    message: string,
  ): Promise<'FAILED'> {
    await this.executions.failStage({
      executionId: claimed.execution.executionId,
      expectedStateVersion: claimed.execution.stateVersion,
      failure: {
        category: 'PERMANENT',
        code,
        message,
        retryable: false,
      },
      leaseOwner: claimed.attempt.leaseOwner,
      stage: 'MAP',
      tenantId: claimed.execution.tenantId,
    });
    return 'FAILED';
  }
}

export { readBoundedJson };
