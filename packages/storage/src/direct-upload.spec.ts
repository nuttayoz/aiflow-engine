import {
  DEFAULT_DIRECT_UPLOAD_POLICY,
  DirectUploadApplicationError,
  DirectUploadService,
  selectDirectUploadPlan,
} from './direct-upload';
import type { DirectUploadStoragePort } from './port';
import type { UploadSessionRepository } from './upload-session.port';
import { createUploadSessionLifecycle } from './upload-session';

const now = new Date('2026-07-21T08:00:00.000Z');
const checksum = Buffer.alloc(32, 4).toString('base64');
const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];

const input = {
  actor: { id: 'upload-user', type: 'USER' as const },
  causationId: 'upload-request-1',
  clientChecksumValue: checksum,
  contentType: 'application/pdf',
  correlationId: 'correlation-1',
  idempotencyKey: 'upload-idempotency-1',
  originalFilename: 'invoice.pdf',
  projectId: 'project-1',
  sizeBytes: 1024,
  tenantId: 'tenant-1',
  workflowId: '20000000-0000-4000-8000-000000000001',
};

const session = (
  plan: ReturnType<typeof selectDirectUploadPlan> | undefined = undefined,
  overrides: Partial<ReturnType<typeof createUploadSessionLifecycle>> = {},
) => {
  const sizeBytes = overrides.sizeBytes ?? input.sizeBytes;
  return {
    ...createUploadSessionLifecycle({
      clientChecksumValue: checksum,
      contentType: input.contentType,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
      id: ids[1]!,
      originalFilename: input.originalFilename,
      plan: plan ?? selectDirectUploadPlan(sizeBytes),
      projectId: input.projectId,
      sizeBytes,
      storageObjectId: ids[0]!,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      workflowVersionId: '20000000-0000-4000-8000-000000000002',
    }),
    ...overrides,
  };
};

const repository = (): jest.Mocked<UploadSessionRepository> => ({
  abort: jest.fn(),
  attachMultipartUpload: jest.fn(),
  create: jest.fn(),
  expire: jest.fn(),
  findById: jest.fn(),
});

const objectStorage = (): jest.Mocked<DirectUploadStoragePort> => ({
  abortMultipartUpload: jest.fn(),
  completeMultipartUpload: jest.fn(),
  createMultipartPartCapability: jest.fn(),
  createMultipartUpload: jest.fn(),
  createSinglePutCapability: jest.fn(),
});

const idGenerator = () => {
  let index = 0;
  return () => ids[index++]!;
};

describe('direct upload application service', () => {
  it('selects the server-owned plan at the configured boundaries', () => {
    expect(
      selectDirectUploadPlan(
        DEFAULT_DIRECT_UPLOAD_POLICY.multipartThresholdBytes,
      ),
    ).toEqual({ type: 'SINGLE_PUT' });
    expect(
      selectDirectUploadPlan(
        DEFAULT_DIRECT_UPLOAD_POLICY.multipartThresholdBytes + 1,
      ),
    ).toEqual({
      partCount: 5,
      partSizeBytes: 16 * 1024 * 1024,
      type: 'MULTIPART',
    });
    expect(() => selectDirectUploadPlan(0)).toThrow(
      new DirectUploadApplicationError('UPLOAD_SESSION_SIZE_INVALID'),
    );
    expect(() => selectDirectUploadPlan(100 * 1024 * 1024 + 1)).toThrow(
      new DirectUploadApplicationError('UPLOAD_SESSION_SIZE_LIMIT_EXCEEDED'),
    );
  });

  it('reserves one single upload and returns a checksum-bound capability', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const created = session();
    sessions.create.mockResolvedValue(created);
    storage.createSinglePutCapability.mockResolvedValue({
      expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
      headers: { 'x-amz-checksum-sha256': checksum },
      method: 'PUT',
      url: 'https://storage.example/upload',
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );

    await expect(service.create(input)).resolves.toEqual({
      expiresAt: created.expiresAt,
      plan: {
        expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        headers: { 'x-amz-checksum-sha256': checksum },
        method: 'PUT',
        type: 'SINGLE_PUT',
        url: 'https://storage.example/upload',
      },
      uploadSessionId: created.id,
    });
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
        plan: { type: 'SINGLE_PUT' },
        retentionUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
        storageObjectId: ids[0],
        uploadSessionId: ids[1],
      }),
    );
    expect(storage.createSinglePutCapability).toHaveBeenCalledWith({
      checksumValue: checksum,
      contentLength: created.sizeBytes,
      contentType: created.contentType,
      expiresInSeconds: 15 * 60,
      storageObjectId: created.storageObjectId,
      tenantId: created.tenantId,
    });
  });

  it('creates and durably binds a multipart upload without exposing its reference', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const plan = selectDirectUploadPlan(64 * 1024 * 1024 + 1);
    const reserved = session(plan, { sizeBytes: 64 * 1024 * 1024 + 1 });
    const attached = {
      ...reserved,
      multipartUploadReference: 'internal-upload-reference',
      stateVersion: 1,
    };
    sessions.create.mockResolvedValue(reserved);
    sessions.attachMultipartUpload.mockResolvedValue(attached);
    storage.createMultipartUpload.mockResolvedValue({
      uploadReference: 'internal-upload-reference',
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );

    const result = await service.create({
      ...input,
      sizeBytes: reserved.sizeBytes,
    });

    expect(result).toEqual({
      expiresAt: attached.expiresAt,
      plan,
      uploadSessionId: attached.id,
    });
    expect(JSON.stringify(result)).not.toContain('internal-upload-reference');
    expect(sessions.attachMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStateVersion: 0,
        multipartUploadReference: 'internal-upload-reference',
        tenantId: attached.tenantId,
        uploadSessionId: attached.id,
      }),
    );
  });

  it('reconciles a concurrent multipart binding and aborts only its extra upload', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const plan = selectDirectUploadPlan(64 * 1024 * 1024 + 1);
    const reserved = session(plan, { sizeBytes: 64 * 1024 * 1024 + 1 });
    const canonical = {
      ...reserved,
      multipartUploadReference: 'canonical-reference',
      stateVersion: 1,
    };
    sessions.create.mockResolvedValue(reserved);
    sessions.attachMultipartUpload.mockRejectedValue(
      new Error('UPLOAD_SESSION_TRANSITION_CONFLICT'),
    );
    sessions.findById.mockResolvedValue(canonical);
    storage.createMultipartUpload.mockResolvedValue({
      uploadReference: 'extra-reference',
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );

    await expect(
      service.create({ ...input, sizeBytes: reserved.sizeBytes }),
    ).resolves.toMatchObject({ uploadSessionId: canonical.id, plan });
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
      storageObjectId: canonical.storageObjectId,
      tenantId: canonical.tenantId,
      uploadReference: 'extra-reference',
    });
  });

  it('reuses an existing multipart binding without creating another upload', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const plan = selectDirectUploadPlan(64 * 1024 * 1024 + 1);
    const attached = session(plan, {
      multipartUploadReference: 'existing-reference',
      sizeBytes: 64 * 1024 * 1024 + 1,
      stateVersion: 1,
    });
    sessions.create.mockResolvedValue(attached);
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );

    await expect(
      service.create({ ...input, sizeBytes: attached.sizeBytes }),
    ).resolves.toEqual({
      expiresAt: attached.expiresAt,
      plan,
      uploadSessionId: attached.id,
    });
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    expect(sessions.attachMultipartUpload).not.toHaveBeenCalled();
  });

  it('does not issue a capability for an expired idempotent session', async () => {
    const sessions = repository();
    const storage = objectStorage();
    sessions.create.mockResolvedValue(
      session(undefined, { expiresAt: now, status: 'ACTIVE' }),
    );
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );

    await expect(service.create(input)).rejects.toThrow(
      new DirectUploadApplicationError('UPLOAD_SESSION_EXPIRED'),
    );
    expect(storage.createSinglePutCapability).not.toHaveBeenCalled();
  });

  it('does not return a plan when reconciliation finds a closed session', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const plan = selectDirectUploadPlan(64 * 1024 * 1024 + 1);
    const reserved = session(plan, { sizeBytes: 64 * 1024 * 1024 + 1 });
    sessions.create.mockResolvedValue(reserved);
    sessions.attachMultipartUpload.mockRejectedValue(
      new Error('UPLOAD_SESSION_TRANSITION_CONFLICT'),
    );
    sessions.findById.mockResolvedValue({
      ...reserved,
      abortedAt: now,
      multipartUploadReference: 'canonical-reference',
      stateVersion: 2,
      status: 'ABORTED',
    });
    storage.createMultipartUpload.mockResolvedValue({
      uploadReference: 'extra-reference',
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );

    await expect(
      service.create({ ...input, sizeBytes: reserved.sizeBytes }),
    ).rejects.toThrow(
      new DirectUploadApplicationError('UPLOAD_SESSION_NOT_ACTIVE'),
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadReference: 'extra-reference' }),
    );
  });
});
