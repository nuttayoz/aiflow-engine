import { randomUUID } from 'node:crypto';

import type { ActorIdentity } from '@aiflow/core';

import type { DirectUploadStoragePort, UploadCapability } from './port';
import type { UploadSessionRepository } from './upload-session.port';
import type { UploadPlan, UploadSessionRecord } from './upload-session';

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
  | 'UPLOAD_SESSION_NOT_ACTIVE'
  | 'UPLOAD_SESSION_SIZE_INVALID'
  | 'UPLOAD_SESSION_SIZE_LIMIT_EXCEEDED';

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
