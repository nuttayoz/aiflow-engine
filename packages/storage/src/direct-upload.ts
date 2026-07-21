import { randomUUID } from 'node:crypto';

import type { ActorIdentity } from '@aiflow/core';

import type {
  DirectUploadStoragePort,
  MultipartPartReceipt,
  UploadCapability,
} from './port';
import type { UploadSessionRepository } from './upload-session.port';
import {
  compositeSha256Checksum,
  type UploadSessionPartRecord,
} from './upload-session-part';
import type { UploadPlan, UploadSessionRecord } from './upload-session';
import type { StoredObjectMetadata } from './types';

const MEBIBYTE = 1024 * 1024;
const DAY_SECONDS = 24 * 60 * 60;

export interface DirectUploadPolicy {
  readonly capabilityLifetimeSeconds: number;
  readonly maximumSourceSizeBytes: number;
  readonly multipartPartSizeBytes: number;
  readonly multipartThresholdBytes: number;
  readonly retentionSeconds: number;
  readonly sessionLifetimeSeconds: number;
}

export const DEFAULT_DIRECT_UPLOAD_POLICY: DirectUploadPolicy = Object.freeze({
  capabilityLifetimeSeconds: 15 * 60,
  maximumSourceSizeBytes: 100 * MEBIBYTE,
  multipartPartSizeBytes: 16 * MEBIBYTE,
  multipartThresholdBytes: 64 * MEBIBYTE,
  retentionSeconds: 30 * DAY_SECONDS,
  sessionLifetimeSeconds: 60 * 60,
});

export type DirectUploadApplicationErrorCode =
  | 'DIRECT_UPLOAD_POLICY_INVALID'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'UPLOAD_SESSION_MULTIPART_NOT_READY'
  | 'UPLOAD_SESSION_NOT_ACTIVE'
  | 'UPLOAD_SESSION_NOT_FOUND'
  | 'UPLOAD_SESSION_SIZE_INVALID'
  | 'UPLOAD_SESSION_SIZE_LIMIT_EXCEEDED'
  | 'UPLOAD_COMPLETION_OBJECT_MISSING'
  | 'UPLOAD_COMPLETION_PARTS_INVALID'
  | 'UPLOAD_INTEGRITY_MISMATCH';

export class DirectUploadApplicationError extends Error {
  constructor(readonly code: DirectUploadApplicationErrorCode) {
    super(code);
    this.name = 'DirectUploadApplicationError';
  }
}

export type BrowserUploadPlan =
  | (UploadCapability & { readonly type: 'SINGLE_PUT' })
  | {
      readonly partCount: number;
      readonly partSizeBytes: number;
      readonly type: 'MULTIPART';
    };

export interface CreateDirectUploadInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly clientChecksumValue: string;
  readonly contentType: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly originalFilename: string;
  readonly projectId: string;
  readonly sizeBytes: number;
  readonly tenantId: string;
  readonly workflowId: string;
}

export interface CreateDirectUploadResult {
  readonly expiresAt: Date;
  readonly plan: BrowserUploadPlan;
  readonly uploadSessionId: string;
}

export interface IssueMultipartPartCapabilityInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly checksumValue: string;
  readonly contentLength: number;
  readonly correlationId: string;
  readonly partNumber: number;
  readonly tenantId: string;
  readonly uploadSessionId: string;
}

export interface MultipartCompletionReceipt {
  readonly checksumValue: string;
  readonly etag: string;
  readonly partNumber: number;
}

export interface CompleteDirectUploadInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly parts?: readonly MultipartCompletionReceipt[];
  readonly tenantId: string;
  readonly uploadSessionId: string;
}

export interface CompleteDirectUploadResult {
  readonly documentId: string;
  readonly executionId: string;
  readonly uploadSessionId: string;
}

const requirePositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const validatePolicy = (policy: DirectUploadPolicy): void => {
  if (
    !requirePositiveInteger(policy.capabilityLifetimeSeconds) ||
    !requirePositiveInteger(policy.maximumSourceSizeBytes) ||
    !requirePositiveInteger(policy.multipartPartSizeBytes) ||
    !requirePositiveInteger(policy.multipartThresholdBytes) ||
    !requirePositiveInteger(policy.retentionSeconds) ||
    !requirePositiveInteger(policy.sessionLifetimeSeconds) ||
    policy.capabilityLifetimeSeconds > policy.sessionLifetimeSeconds ||
    policy.multipartThresholdBytes < policy.multipartPartSizeBytes ||
    policy.maximumSourceSizeBytes <= policy.multipartThresholdBytes ||
    Math.ceil(policy.maximumSourceSizeBytes / policy.multipartPartSizeBytes) >
      10_000 ||
    policy.retentionSeconds <= policy.sessionLifetimeSeconds
  ) {
    throw new DirectUploadApplicationError('DIRECT_UPLOAD_POLICY_INVALID');
  }
};

export const selectDirectUploadPlan = (
  sizeBytes: number,
  policy: DirectUploadPolicy = DEFAULT_DIRECT_UPLOAD_POLICY,
): UploadPlan => {
  validatePolicy(policy);
  if (!requirePositiveInteger(sizeBytes)) {
    throw new DirectUploadApplicationError('UPLOAD_SESSION_SIZE_INVALID');
  }
  if (sizeBytes > policy.maximumSourceSizeBytes) {
    throw new DirectUploadApplicationError(
      'UPLOAD_SESSION_SIZE_LIMIT_EXCEEDED',
    );
  }
  if (sizeBytes <= policy.multipartThresholdBytes) {
    return { type: 'SINGLE_PUT' };
  }
  return {
    partCount: Math.ceil(sizeBytes / policy.multipartPartSizeBytes),
    partSizeBytes: policy.multipartPartSizeBytes,
    type: 'MULTIPART',
  };
};

type Clock = () => Date;
type IdGenerator = () => string;

export class DirectUploadService {
  constructor(
    private readonly sessions: UploadSessionRepository,
    private readonly storage: DirectUploadStoragePort,
    private readonly policy: DirectUploadPolicy = DEFAULT_DIRECT_UPLOAD_POLICY,
    private readonly clock: Clock = () => new Date(),
    private readonly generateId: IdGenerator = randomUUID,
  ) {
    validatePolicy(policy);
  }

  async create(
    input: CreateDirectUploadInput,
  ): Promise<CreateDirectUploadResult> {
    const plan = selectDirectUploadPlan(input.sizeBytes, this.policy);
    const now = this.clock();
    const session = await this.sessions.create({
      ...input,
      expiresAt: new Date(
        now.getTime() + this.policy.sessionLifetimeSeconds * 1_000,
      ),
      plan,
      retentionUntil: new Date(
        now.getTime() + this.policy.retentionSeconds * 1_000,
      ),
      storageObjectId: this.generateId(),
      uploadSessionId: this.generateId(),
    });
    const active = await this.ensureMultipartUpload(session, input);
    const expiresInSeconds = this.capabilityLifetime(active);
    if (active.plan.type === 'MULTIPART') {
      return {
        expiresAt: active.expiresAt,
        plan: active.plan,
        uploadSessionId: active.id,
      };
    }

    const capability = await this.storage.createSinglePutCapability({
      checksumValue: active.clientChecksum.value,
      contentLength: active.sizeBytes,
      contentType: active.contentType,
      expiresInSeconds,
      storageObjectId: active.storageObjectId,
      tenantId: active.tenantId,
    });
    return {
      expiresAt: active.expiresAt,
      plan: { ...capability, type: 'SINGLE_PUT' },
      uploadSessionId: active.id,
    };
  }

  async issueMultipartPartCapability(
    input: IssueMultipartPartCapabilityInput,
  ): Promise<UploadCapability> {
    const pinned = await this.sessions.pinPart(input);
    const uploadReference = pinned.session.multipartUploadReference;
    if (
      pinned.session.plan.type !== 'MULTIPART' ||
      uploadReference === undefined
    ) {
      throw new DirectUploadApplicationError(
        'UPLOAD_SESSION_MULTIPART_NOT_READY',
      );
    }
    const expiresInSeconds = this.capabilityLifetime(pinned.session);
    return this.storage.createMultipartPartCapability({
      checksumValue: pinned.part.checksum.value,
      contentLength: pinned.part.sizeBytes,
      expiresInSeconds,
      partNumber: pinned.part.partNumber,
      storageObjectId: pinned.session.storageObjectId,
      tenantId: pinned.session.tenantId,
      uploadReference,
    });
  }

  async complete(
    input: CompleteDirectUploadInput,
  ): Promise<CompleteDirectUploadResult> {
    const session = await this.sessions.findById(
      input.tenantId,
      input.uploadSessionId,
    );
    if (session === undefined) {
      throw new DirectUploadApplicationError('UPLOAD_SESSION_NOT_FOUND');
    }
    if (
      session.status === 'COMPLETED' &&
      session.documentId !== undefined &&
      session.executionId !== undefined
    ) {
      return {
        documentId: session.documentId,
        executionId: session.executionId,
        uploadSessionId: session.id,
      };
    }
    this.capabilityLifetime(session);

    const metadata =
      session.plan.type === 'SINGLE_PUT'
        ? await this.inspectSingleUpload(session, input.parts)
        : await this.completeOrReconcileMultipart(session, input.parts);
    const committed = await this.sessions.commitCompletion({
      actor: input.actor,
      causationId: input.causationId,
      correlationId: input.correlationId,
      documentId: this.generateId(),
      executionId: this.generateId(),
      idempotencyKey: input.idempotencyKey,
      metadata,
      tenantId: session.tenantId,
      uploadSessionId: session.id,
    });
    return {
      documentId: committed.documentId,
      executionId: committed.executionId,
      uploadSessionId: committed.session.id,
    };
  }

  private capabilityLifetime(session: UploadSessionRecord): number {
    const remainingSeconds = Math.floor(
      (session.expiresAt.getTime() - this.clock().getTime()) / 1_000,
    );
    if (session.status !== 'ACTIVE') {
      throw new DirectUploadApplicationError('UPLOAD_SESSION_NOT_ACTIVE');
    }
    if (remainingSeconds < 1) {
      throw new DirectUploadApplicationError('UPLOAD_SESSION_EXPIRED');
    }
    return Math.min(remainingSeconds, this.policy.capabilityLifetimeSeconds);
  }

  private async inspectSingleUpload(
    session: UploadSessionRecord,
    receipts: readonly MultipartCompletionReceipt[] | undefined,
  ) {
    if (receipts !== undefined && receipts.length > 0) {
      throw new DirectUploadApplicationError('UPLOAD_COMPLETION_PARTS_INVALID');
    }
    const metadata = await this.storage.inspectUpload({
      storageObjectId: session.storageObjectId,
      tenantId: session.tenantId,
    });
    if (metadata === undefined) {
      throw new DirectUploadApplicationError(
        'UPLOAD_COMPLETION_OBJECT_MISSING',
      );
    }
    this.verifyMetadata(session, metadata, {
      algorithm: 'SHA256',
      type: 'FULL_OBJECT',
      value: session.clientChecksum.value,
    });
    return metadata;
  }

  private async completeOrReconcileMultipart(
    session: UploadSessionRecord,
    receipts: readonly MultipartCompletionReceipt[] | undefined,
  ) {
    const uploadReference = session.multipartUploadReference;
    if (uploadReference === undefined) {
      throw new DirectUploadApplicationError(
        'UPLOAD_SESSION_MULTIPART_NOT_READY',
      );
    }
    const pinned = await this.sessions.findParts(session.tenantId, session.id);
    const parts = this.validateMultipartReceipts(session, pinned, receipts);
    const expectedChecksum = {
      algorithm: 'SHA256' as const,
      type: 'COMPOSITE' as const,
      value: compositeSha256Checksum(pinned.map((part) => part.checksum.value)),
    };
    let metadata = await this.storage.inspectUpload({
      storageObjectId: session.storageObjectId,
      tenantId: session.tenantId,
    });
    if (metadata === undefined) {
      try {
        const completed = await this.storage.completeMultipartUpload({
          parts,
          sizeBytes: session.sizeBytes,
          storageObjectId: session.storageObjectId,
          tenantId: session.tenantId,
          uploadReference,
        });
        metadata = await this.storage.inspectUpload({
          storageObjectId: session.storageObjectId,
          tenantId: session.tenantId,
          versionId: completed.versionId,
        });
      } catch (error) {
        metadata = await this.storage.inspectUpload({
          storageObjectId: session.storageObjectId,
          tenantId: session.tenantId,
        });
        if (metadata === undefined) {
          throw error;
        }
      }
    }
    if (metadata === undefined) {
      throw new DirectUploadApplicationError(
        'UPLOAD_COMPLETION_OBJECT_MISSING',
      );
    }
    this.verifyMetadata(session, metadata, expectedChecksum);
    return metadata;
  }

  private validateMultipartReceipts(
    session: UploadSessionRecord,
    pinned: readonly UploadSessionPartRecord[],
    receipts: readonly MultipartCompletionReceipt[] | undefined,
  ): readonly MultipartPartReceipt[] {
    if (
      session.plan.type !== 'MULTIPART' ||
      receipts === undefined ||
      pinned.length !== session.plan.partCount ||
      receipts.length !== pinned.length
    ) {
      throw new DirectUploadApplicationError('UPLOAD_COMPLETION_PARTS_INVALID');
    }
    return pinned.map((part, index) => {
      const receipt = receipts[index];
      if (
        receipt === undefined ||
        part.partNumber !== index + 1 ||
        receipt.partNumber !== part.partNumber ||
        receipt.checksumValue !== part.checksum.value ||
        receipt.etag.trim().length === 0 ||
        receipt.etag.length > 1_024
      ) {
        throw new DirectUploadApplicationError(
          'UPLOAD_COMPLETION_PARTS_INVALID',
        );
      }
      return {
        checksumValue: part.checksum.value,
        etag: receipt.etag,
        partNumber: part.partNumber,
      };
    });
  }

  private verifyMetadata(
    session: UploadSessionRecord,
    metadata: StoredObjectMetadata,
    expectedChecksum: {
      readonly algorithm: 'SHA256';
      readonly type: 'COMPOSITE' | 'FULL_OBJECT';
      readonly value: string;
    },
  ): void {
    if (
      metadata.sizeBytes !== session.sizeBytes ||
      metadata.contentType !== session.contentType ||
      metadata.checksum.algorithm !== expectedChecksum.algorithm ||
      metadata.checksum.type !== expectedChecksum.type ||
      metadata.checksum.value !== expectedChecksum.value
    ) {
      throw new DirectUploadApplicationError('UPLOAD_INTEGRITY_MISMATCH');
    }
  }

  private async ensureMultipartUpload(
    session: UploadSessionRecord,
    input: CreateDirectUploadInput,
  ): Promise<UploadSessionRecord> {
    this.capabilityLifetime(session);
    if (
      session.plan.type !== 'MULTIPART' ||
      session.multipartUploadReference !== undefined
    ) {
      return session;
    }

    const created = await this.storage.createMultipartUpload({
      contentType: session.contentType,
      storageObjectId: session.storageObjectId,
      tenantId: session.tenantId,
    });
    try {
      return await this.sessions.attachMultipartUpload({
        actor: input.actor,
        causationId: input.causationId,
        correlationId: input.correlationId,
        expectedStateVersion: session.stateVersion,
        multipartUploadReference: created.uploadReference,
        tenantId: session.tenantId,
        uploadSessionId: session.id,
      });
    } catch (error) {
      const current = await this.sessions.findById(
        session.tenantId,
        session.id,
      );
      if (current?.multipartUploadReference === created.uploadReference) {
        return current;
      }
      await this.storage.abortMultipartUpload({
        storageObjectId: session.storageObjectId,
        tenantId: session.tenantId,
        uploadReference: created.uploadReference,
      });
      if (current?.multipartUploadReference !== undefined) {
        return current;
      }
      throw error;
    }
  }
}
