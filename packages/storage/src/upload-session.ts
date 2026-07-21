export const UPLOAD_SESSION_STATUSES = [
  'ACTIVE',
  'COMPLETED',
  'ABORTED',
  'EXPIRED',
] as const;

export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export type UploadPlan =
  | { readonly type: 'SINGLE_PUT' }
  | {
      readonly partCount: number;
      readonly partSizeBytes: number;
      readonly type: 'MULTIPART';
    };

export interface UploadSessionRecord {
  readonly abortedAt?: Date;
  readonly clientChecksum: {
    readonly algorithm: 'SHA256';
    readonly value: string;
  };
  readonly completedAt?: Date;
  readonly contentType: string;
  readonly createdAt: Date;
  readonly documentId?: string;
  readonly executionId?: string;
  readonly expiresAt: Date;
  readonly id: string;
  readonly multipartUploadReference?: string;
  readonly originalFilename: string;
  readonly plan: UploadPlan;
  readonly projectId: string;
  readonly sizeBytes: number;
  readonly stateVersion: number;
  readonly status: UploadSessionStatus;
  readonly storageObjectId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export type UploadSessionTransitionErrorCode =
  | 'UPLOAD_SESSION_ALREADY_CLOSED'
  | 'UPLOAD_SESSION_CHECKSUM_INVALID'
  | 'UPLOAD_SESSION_COMPLETION_CONFLICT'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'UPLOAD_SESSION_INPUT_INVALID'
  | 'UPLOAD_SESSION_MULTIPART_CONFLICT'
  | 'UPLOAD_SESSION_NOT_EXPIRED'
  | 'UPLOAD_SESSION_PLAN_INVALID'
  | 'UPLOAD_SESSION_STATE_VERSION_MISMATCH';

export class UploadSessionTransitionError extends Error {
  constructor(readonly code: UploadSessionTransitionErrorCode) {
    super(code);
    this.name = 'UploadSessionTransitionError';
  }
}

const isCanonicalSha256 = (value: string): boolean => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
};

const requireIdentifier = (value: string): void => {
  if (
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 180
  ) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_INPUT_INVALID');
  }
};

const requirePlan = (plan: UploadPlan, sizeBytes: number): void => {
  if (plan.type === 'SINGLE_PUT') {
    return;
  }
  if (
    !Number.isSafeInteger(plan.partSizeBytes) ||
    plan.partSizeBytes <= 0 ||
    !Number.isSafeInteger(plan.partCount) ||
    plan.partCount < 2 ||
    Math.ceil(sizeBytes / plan.partSizeBytes) !== plan.partCount
  ) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_PLAN_INVALID');
  }
};

export interface CreateUploadSessionLifecycleInput {
  readonly clientChecksumValue: string;
  readonly contentType: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly id: string;
  readonly originalFilename: string;
  readonly plan: UploadPlan;
  readonly projectId: string;
  readonly sizeBytes: number;
  readonly storageObjectId: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export const createUploadSessionLifecycle = (
  input: CreateUploadSessionLifecycleInput,
): UploadSessionRecord => {
  for (const identifier of [
    input.id,
    input.tenantId,
    input.projectId,
    input.storageObjectId,
    input.workflowId,
    input.workflowVersionId,
  ]) {
    requireIdentifier(identifier);
  }
  if (
    input.originalFilename.trim().length === 0 ||
    input.originalFilename.length > 512 ||
    input.contentType.trim().length === 0 ||
    input.contentType.length > 255 ||
    /[\r\n]/u.test(input.contentType) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    !Number.isFinite(input.createdAt.getTime()) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= input.createdAt.getTime()
  ) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_INPUT_INVALID');
  }
  if (!isCanonicalSha256(input.clientChecksumValue)) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_CHECKSUM_INVALID');
  }
  requirePlan(input.plan, input.sizeBytes);

  return {
    clientChecksum: {
      algorithm: 'SHA256',
      value: input.clientChecksumValue,
    },
    contentType: input.contentType.trim().toLowerCase(),
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.expiresAt),
    id: input.id,
    originalFilename: input.originalFilename.trim(),
    plan: input.plan,
    projectId: input.projectId,
    sizeBytes: input.sizeBytes,
    stateVersion: 0,
    status: 'ACTIVE',
    storageObjectId: input.storageObjectId,
    tenantId: input.tenantId,
    updatedAt: new Date(input.createdAt),
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
  };
};

const requireActive = (
  session: UploadSessionRecord,
  expectedStateVersion: number,
  now: Date,
): void => {
  if (session.status !== 'ACTIVE') {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_ALREADY_CLOSED');
  }
  if (session.stateVersion !== expectedStateVersion) {
    throw new UploadSessionTransitionError(
      'UPLOAD_SESSION_STATE_VERSION_MISMATCH',
    );
  }
  if (now.getTime() >= session.expiresAt.getTime()) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_EXPIRED');
  }
};

export const attachMultipartUpload = (
  session: UploadSessionRecord,
  input: {
    readonly expectedStateVersion: number;
    readonly multipartUploadReference: string;
    readonly now: Date;
  },
): UploadSessionRecord => {
  if (session.status !== 'ACTIVE') {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_ALREADY_CLOSED');
  }
  if (input.now.getTime() >= session.expiresAt.getTime()) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_EXPIRED');
  }
  if (session.multipartUploadReference === input.multipartUploadReference) {
    return session;
  }
  requireActive(session, input.expectedStateVersion, input.now);
  if (
    session.plan.type !== 'MULTIPART' ||
    input.multipartUploadReference.trim().length === 0 ||
    input.multipartUploadReference.length > 1024 ||
    session.multipartUploadReference !== undefined
  ) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_MULTIPART_CONFLICT');
  }

  return {
    ...session,
    multipartUploadReference: input.multipartUploadReference,
    stateVersion: session.stateVersion + 1,
    updatedAt: new Date(input.now),
  };
};

export const completeUploadSession = (
  session: UploadSessionRecord,
  input: {
    readonly documentId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly now: Date;
  },
): UploadSessionRecord => {
  if (session.status === 'COMPLETED') {
    if (
      session.documentId === input.documentId &&
      session.executionId === input.executionId
    ) {
      return session;
    }
    throw new UploadSessionTransitionError(
      'UPLOAD_SESSION_COMPLETION_CONFLICT',
    );
  }
  requireActive(session, input.expectedStateVersion, input.now);
  requireIdentifier(input.documentId);
  requireIdentifier(input.executionId);

  return {
    ...session,
    completedAt: new Date(input.now),
    documentId: input.documentId,
    executionId: input.executionId,
    stateVersion: session.stateVersion + 1,
    status: 'COMPLETED',
    updatedAt: new Date(input.now),
  };
};

export const abortUploadSession = (
  session: UploadSessionRecord,
  input: { readonly expectedStateVersion: number; readonly now: Date },
): UploadSessionRecord => {
  if (session.status === 'ABORTED') {
    return session;
  }
  if (session.status !== 'ACTIVE') {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_ALREADY_CLOSED');
  }
  if (session.stateVersion !== input.expectedStateVersion) {
    throw new UploadSessionTransitionError(
      'UPLOAD_SESSION_STATE_VERSION_MISMATCH',
    );
  }

  return {
    ...session,
    abortedAt: new Date(input.now),
    stateVersion: session.stateVersion + 1,
    status: 'ABORTED',
    updatedAt: new Date(input.now),
  };
};

export const expireUploadSession = (
  session: UploadSessionRecord,
  input: { readonly expectedStateVersion: number; readonly now: Date },
): UploadSessionRecord => {
  if (session.status === 'EXPIRED') {
    return session;
  }
  if (session.status !== 'ACTIVE') {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_ALREADY_CLOSED');
  }
  if (session.stateVersion !== input.expectedStateVersion) {
    throw new UploadSessionTransitionError(
      'UPLOAD_SESSION_STATE_VERSION_MISMATCH',
    );
  }
  if (input.now.getTime() < session.expiresAt.getTime()) {
    throw new UploadSessionTransitionError('UPLOAD_SESSION_NOT_EXPIRED');
  }

  return {
    ...session,
    abortedAt: new Date(input.now),
    stateVersion: session.stateVersion + 1,
    status: 'EXPIRED',
    updatedAt: new Date(input.now),
  };
};
