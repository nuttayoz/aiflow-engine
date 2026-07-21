import {
  createUploadSessionPart,
  expectedMultipartPartSize,
  reconcileUploadSessionPart,
  UploadSessionPartError,
} from './upload-session-part';
import { createUploadSessionLifecycle } from './upload-session';

const now = new Date('2026-07-21T09:00:00.000Z');
const checksum = Buffer.alloc(32, 5).toString('base64');

const multipartSession = () => ({
  ...createUploadSessionLifecycle({
    clientChecksumValue: checksum,
    contentType: 'application/pdf',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    id: 'upload-session-1',
    originalFilename: 'invoice.pdf',
    plan: { partCount: 3, partSizeBytes: 16, type: 'MULTIPART' },
    projectId: 'project-1',
    sizeBytes: 40,
    storageObjectId: 'storage-object-1',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    workflowVersionId: 'workflow-version-1',
  }),
  multipartUploadReference: 'internal-reference',
  stateVersion: 1,
});

describe('upload session parts', () => {
  it('derives full and final part sizes from the durable plan', () => {
    const session = multipartSession();
    expect(expectedMultipartPartSize(session, 1)).toBe(16);
    expect(expectedMultipartPartSize(session, 2)).toBe(16);
    expect(expectedMultipartPartSize(session, 3)).toBe(8);
  });

  it('pins one canonical checksum and replays the same part idempotently', () => {
    const pinned = createUploadSessionPart(multipartSession(), {
      checksumValue: checksum,
      contentLength: 16,
      now,
      partNumber: 1,
    });
    expect(pinned).toMatchObject({
      checksum: { algorithm: 'SHA256', value: checksum },
      partNumber: 1,
      sizeBytes: 16,
    });
    expect(reconcileUploadSessionPart(pinned, { ...pinned })).toBe(pinned);
    expect(() =>
      reconcileUploadSessionPart(pinned, {
        ...pinned,
        checksum: {
          algorithm: 'SHA256',
          value: Buffer.alloc(32, 6).toString('base64'),
        },
      }),
    ).toThrow(new UploadSessionPartError('UPLOAD_PART_CONFLICT'));
  });

  it('rejects invalid numbers, sizes, checksums, lifecycle, and readiness', () => {
    const session = multipartSession();
    expect(() => expectedMultipartPartSize(session, 4)).toThrow(
      new UploadSessionPartError('UPLOAD_PART_NUMBER_INVALID'),
    );
    expect(() =>
      createUploadSessionPart(session, {
        checksumValue: checksum,
        contentLength: 15,
        now,
        partNumber: 1,
      }),
    ).toThrow(new UploadSessionPartError('UPLOAD_PART_SIZE_MISMATCH'));
    expect(() =>
      createUploadSessionPart(session, {
        checksumValue: 'invalid',
        contentLength: 16,
        now,
        partNumber: 1,
      }),
    ).toThrow(new UploadSessionPartError('UPLOAD_PART_CHECKSUM_INVALID'));
    expect(() =>
      createUploadSessionPart(
        { ...session, multipartUploadReference: undefined },
        {
          checksumValue: checksum,
          contentLength: 16,
          now,
          partNumber: 1,
        },
      ),
    ).toThrow(new UploadSessionPartError('UPLOAD_SESSION_MULTIPART_NOT_READY'));
    expect(() =>
      createUploadSessionPart(
        { ...session, status: 'ABORTED' },
        {
          checksumValue: checksum,
          contentLength: 16,
          now,
          partNumber: 1,
        },
      ),
    ).toThrow(new UploadSessionPartError('UPLOAD_SESSION_NOT_ACTIVE'));
    expect(() =>
      createUploadSessionPart(session, {
        checksumValue: checksum,
        contentLength: 16,
        now: session.expiresAt,
        partNumber: 1,
      }),
    ).toThrow(new UploadSessionPartError('UPLOAD_SESSION_EXPIRED'));
  });
});
