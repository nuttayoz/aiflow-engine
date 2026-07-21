import type { ActorIdentity } from '@aiflow/core';

import type { UploadPlan, UploadSessionRecord } from './upload-session';
import type { UploadSessionPartRecord } from './upload-session-part';

export interface CreateUploadSessionInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly clientChecksumValue: string;
  readonly contentType: string;
  readonly correlationId: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  readonly originalFilename: string;
  readonly plan: UploadPlan;
  readonly projectId: string;
  readonly retentionUntil: Date;
  readonly sizeBytes: number;
  readonly storageObjectId: string;
  readonly tenantId: string;
  readonly uploadSessionId: string;
  readonly workflowId: string;
}

export interface UploadSessionMutationInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly expectedStateVersion: number;
  readonly tenantId: string;
  readonly uploadSessionId: string;
}

export interface PinUploadSessionPartInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly checksumValue: string;
  readonly contentLength: number;
  readonly correlationId: string;
  readonly partNumber: number;
  readonly tenantId: string;
  readonly uploadSessionId: string;
}

export interface PinUploadSessionPartResult {
  readonly part: UploadSessionPartRecord;
  readonly session: UploadSessionRecord;
}

export interface UploadSessionRepository {
  abort(input: UploadSessionMutationInput): Promise<UploadSessionRecord>;
  attachMultipartUpload(
    input: UploadSessionMutationInput & {
      readonly multipartUploadReference: string;
    },
  ): Promise<UploadSessionRecord>;
  create(input: CreateUploadSessionInput): Promise<UploadSessionRecord>;
  expire(input: UploadSessionMutationInput): Promise<UploadSessionRecord>;
  findById(
    tenantId: string,
    uploadSessionId: string,
  ): Promise<UploadSessionRecord | undefined>;
  pinPart(
    input: PinUploadSessionPartInput,
  ): Promise<PinUploadSessionPartResult>;
}
