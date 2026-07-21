import type { UploadSessionRecord } from './upload-session';

export interface UploadSessionPartRecord {
  readonly checksum: {
    readonly algorithm: 'SHA256';
    readonly value: string;
  };
  readonly createdAt: Date;
  readonly partNumber: number;
  readonly sizeBytes: number;
  readonly tenantId: string;
  readonly uploadSessionId: string;
}

export type UploadSessionPartErrorCode =
  | 'UPLOAD_PART_CHECKSUM_INVALID'
  | 'UPLOAD_PART_CONFLICT'
  | 'UPLOAD_PART_NUMBER_INVALID'
  | 'UPLOAD_PART_SIZE_MISMATCH'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'UPLOAD_SESSION_MULTIPART_NOT_READY'
  | 'UPLOAD_SESSION_NOT_ACTIVE';

export class UploadSessionPartError extends Error {
  constructor(readonly code: UploadSessionPartErrorCode) {
    super(code);
    this.name = 'UploadSessionPartError';
  }
}

const isCanonicalSha256 = (value: string): boolean => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
};

export const expectedMultipartPartSize = (
  session: UploadSessionRecord,
  partNumber: number,
): number => {
  if (
    session.plan.type !== 'MULTIPART' ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > session.plan.partCount
  ) {
    throw new UploadSessionPartError('UPLOAD_PART_NUMBER_INVALID');
  }
  return partNumber === session.plan.partCount
    ? session.sizeBytes - session.plan.partSizeBytes * (partNumber - 1)
    : session.plan.partSizeBytes;
};

export const createUploadSessionPart = (
  session: UploadSessionRecord,
  input: {
    readonly checksumValue: string;
    readonly contentLength: number;
    readonly now: Date;
    readonly partNumber: number;
  },
): UploadSessionPartRecord => {
  if (session.status !== 'ACTIVE') {
    throw new UploadSessionPartError('UPLOAD_SESSION_NOT_ACTIVE');
  }
  if (input.now.getTime() >= session.expiresAt.getTime()) {
    throw new UploadSessionPartError('UPLOAD_SESSION_EXPIRED');
  }
  if (
    session.plan.type !== 'MULTIPART' ||
    session.multipartUploadReference === undefined
  ) {
    throw new UploadSessionPartError('UPLOAD_SESSION_MULTIPART_NOT_READY');
  }
  const expectedSize = expectedMultipartPartSize(session, input.partNumber);
  if (
    !Number.isSafeInteger(input.contentLength) ||
    input.contentLength !== expectedSize
  ) {
    throw new UploadSessionPartError('UPLOAD_PART_SIZE_MISMATCH');
  }
  if (!isCanonicalSha256(input.checksumValue)) {
    throw new UploadSessionPartError('UPLOAD_PART_CHECKSUM_INVALID');
  }

  return {
    checksum: { algorithm: 'SHA256', value: input.checksumValue },
    createdAt: new Date(input.now),
    partNumber: input.partNumber,
    sizeBytes: input.contentLength,
    tenantId: session.tenantId,
    uploadSessionId: session.id,
  };
};

export const reconcileUploadSessionPart = (
  existing: UploadSessionPartRecord,
  candidate: UploadSessionPartRecord,
): UploadSessionPartRecord => {
  if (
    existing.tenantId === candidate.tenantId &&
    existing.uploadSessionId === candidate.uploadSessionId &&
    existing.partNumber === candidate.partNumber &&
    existing.sizeBytes === candidate.sizeBytes &&
    existing.checksum.algorithm === candidate.checksum.algorithm &&
    existing.checksum.value === candidate.checksum.value
  ) {
    return existing;
  }
  throw new UploadSessionPartError('UPLOAD_PART_CONFLICT');
};
