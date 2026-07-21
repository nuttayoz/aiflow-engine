import {
  abortUploadSession,
  attachMultipartUpload,
  completeUploadSession,
  createUploadSessionLifecycle,
  expireUploadSession,
  UploadSessionTransitionError,
} from './upload-session';

const now = new Date('2026-07-21T00:00:00.000Z');
const expiresAt = new Date('2026-07-21T01:00:00.000Z');
const checksum = Buffer.alloc(32, 7).toString('base64');

const createSinglePart = () =>
  createUploadSessionLifecycle({
    clientChecksumValue: checksum,
    contentType: 'application/pdf',
    createdAt: now,
    expiresAt,
    id: 'upload-session-1',
    originalFilename: 'invoice.pdf',
    plan: { type: 'SINGLE_PUT' },
    projectId: 'project-1',
    sizeBytes: 1024,
    storageObjectId: 'storage-object-1',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    workflowVersionId: 'workflow-version-1',
  });

describe('upload session lifecycle', () => {
  it('creates an active session without exposing a false uploaded state', () => {
    expect(createSinglePart()).toMatchObject({
      clientChecksum: { algorithm: 'SHA256', value: checksum },
      stateVersion: 0,
      status: 'ACTIVE',
    });
  });

  it('validates multipart shape and attaches one opaque upload reference', () => {
    const multipart = createUploadSessionLifecycle({
      ...createSinglePart(),
      clientChecksumValue: checksum,
      createdAt: now,
      expiresAt,
      id: 'upload-session-2',
      plan: { partCount: 3, partSizeBytes: 10, type: 'MULTIPART' },
      sizeBytes: 21,
      storageObjectId: 'storage-object-2',
    });
    const attached = attachMultipartUpload(multipart, {
      expectedStateVersion: 0,
      multipartUploadReference: 'opaque-upload-reference',
      now: new Date('2026-07-21T00:01:00.000Z'),
    });

    expect(attached).toMatchObject({
      multipartUploadReference: 'opaque-upload-reference',
      stateVersion: 1,
    });
    expect(
      attachMultipartUpload(attached, {
        expectedStateVersion: 0,
        multipartUploadReference: 'opaque-upload-reference',
        now: new Date('2026-07-21T00:02:00.000Z'),
      }),
    ).toBe(attached);
  });

  it('completes exactly once and returns the same terminal result on replay', () => {
    const completed = completeUploadSession(createSinglePart(), {
      documentId: 'document-1',
      executionId: 'execution-1',
      expectedStateVersion: 0,
      now: new Date('2026-07-21T00:10:00.000Z'),
    });

    expect(completed).toMatchObject({
      documentId: 'document-1',
      executionId: 'execution-1',
      stateVersion: 1,
      status: 'COMPLETED',
    });
    expect(
      completeUploadSession(completed, {
        documentId: 'document-1',
        executionId: 'execution-1',
        expectedStateVersion: 0,
        now: new Date('2026-07-21T00:11:00.000Z'),
      }),
    ).toBe(completed);
    expect(() =>
      completeUploadSession(completed, {
        documentId: 'different-document',
        executionId: 'execution-1',
        expectedStateVersion: 1,
        now: new Date('2026-07-21T00:11:00.000Z'),
      }),
    ).toThrow(
      new UploadSessionTransitionError('UPLOAD_SESSION_COMPLETION_CONFLICT'),
    );
  });

  it('closes an incomplete session by abort or expiry but never reopens it', () => {
    const aborted = abortUploadSession(createSinglePart(), {
      expectedStateVersion: 0,
      now: new Date('2026-07-21T00:20:00.000Z'),
    });
    expect(aborted.status).toBe('ABORTED');
    expect(
      abortUploadSession(aborted, {
        expectedStateVersion: 0,
        now: new Date('2026-07-21T00:21:00.000Z'),
      }),
    ).toBe(aborted);
    expect(() =>
      completeUploadSession(aborted, {
        documentId: 'document-1',
        executionId: 'execution-1',
        expectedStateVersion: 1,
        now: new Date('2026-07-21T00:22:00.000Z'),
      }),
    ).toThrow(
      new UploadSessionTransitionError('UPLOAD_SESSION_ALREADY_CLOSED'),
    );

    const expired = expireUploadSession(createSinglePart(), {
      expectedStateVersion: 0,
      now: expiresAt,
    });
    expect(expired.status).toBe('EXPIRED');
    expect(() =>
      expireUploadSession(createSinglePart(), {
        expectedStateVersion: 0,
        now: new Date('2026-07-21T00:59:59.000Z'),
      }),
    ).toThrow(new UploadSessionTransitionError('UPLOAD_SESSION_NOT_EXPIRED'));
  });

  it('rejects invalid checksums, plans, expiry, and stale transitions', () => {
    expect(() =>
      createUploadSessionLifecycle({
        ...createSinglePart(),
        clientChecksumValue: 'not-a-sha256',
        createdAt: now,
        expiresAt,
      }),
    ).toThrow(
      new UploadSessionTransitionError('UPLOAD_SESSION_CHECKSUM_INVALID'),
    );
    expect(() =>
      createUploadSessionLifecycle({
        ...createSinglePart(),
        clientChecksumValue: checksum,
        createdAt: now,
        expiresAt,
        plan: { partCount: 2, partSizeBytes: 10, type: 'MULTIPART' },
        sizeBytes: 21,
      }),
    ).toThrow(new UploadSessionTransitionError('UPLOAD_SESSION_PLAN_INVALID'));
    expect(() =>
      completeUploadSession(createSinglePart(), {
        documentId: 'document-1',
        executionId: 'execution-1',
        expectedStateVersion: 1,
        now: new Date('2026-07-21T00:10:00.000Z'),
      }),
    ).toThrow(
      new UploadSessionTransitionError('UPLOAD_SESSION_STATE_VERSION_MISMATCH'),
    );
    expect(() =>
      completeUploadSession(createSinglePart(), {
        documentId: 'document-1',
        executionId: 'execution-1',
        expectedStateVersion: 0,
        now: expiresAt,
      }),
    ).toThrow(new UploadSessionTransitionError('UPLOAD_SESSION_EXPIRED'));
  });
});
