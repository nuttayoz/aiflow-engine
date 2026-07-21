import {
  DEFAULT_DIRECT_UPLOAD_POLICY,
  DirectUploadApplicationError,
  DirectUploadService,
  selectDirectUploadPlan,
} from './direct-upload';
import { buildStorageObjectKey } from './key-policy';
import type { DirectUploadStoragePort } from './port';
import type { UploadSessionRepository } from './upload-session.port';
import { createUploadSessionLifecycle } from './upload-session';
import { compositeSha256Checksum } from './upload-session-part';

const now = new Date('2026-07-21T08:00:00.000Z');
const checksum = Buffer.alloc(32, 4).toString('base64');
const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const completionIds = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
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
  commitCompletion: jest.fn(),
  create: jest.fn(),
  expire: jest.fn(),
  findById: jest.fn(),
  findParts: jest.fn(),
  pinPart: jest.fn(),
});

const objectStorage = (): jest.Mocked<DirectUploadStoragePort> => ({
  abortMultipartUpload: jest.fn(),
  completeMultipartUpload: jest.fn(),
  createMultipartPartCapability: jest.fn(),
  createMultipartUpload: jest.fn(),
  createSinglePutCapability: jest.fn(),
  inspectUpload: jest.fn(),
});

const idGenerator = () => {
  let index = 0;
  return () => ids[index++]!;
};

const completeInput = {
  actor: input.actor,
  causationId: 'upload-complete-request-1',
  correlationId: input.correlationId,
  idempotencyKey: 'upload-complete-idempotency-1',
  tenantId: input.tenantId,
  uploadSessionId: ids[1]!,
};

const storedMetadata = (
  active = session(),
  overrides: Partial<{
    checksum: {
      algorithm: 'SHA256';
      type: 'COMPOSITE' | 'FULL_OBJECT';
      value: string;
    };
    contentType: string;
    sizeBytes: number;
    versionId: string;
  }> = {},
) => ({
  checksum: {
    algorithm: 'SHA256' as const,
    type: 'FULL_OBJECT' as const,
    value: active.clientChecksum.value,
    ...overrides.checksum,
  },
  contentType: overrides.contentType ?? active.contentType,
  encryptionMode: 'AES256',
  key: buildStorageObjectKey(active.tenantId, active.storageObjectId),
  sizeBytes: overrides.sizeBytes ?? active.sizeBytes,
  versionId: overrides.versionId ?? 'stored-version-1',
});

const completionIdGenerator = () => {
  let index = 0;
  return () => completionIds[index++]!;
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

  it('issues a capability from the durable pinned multipart values', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const multipart = session(
      { partCount: 3, partSizeBytes: 16, type: 'MULTIPART' },
      {
        multipartUploadReference: 'internal-reference',
        sizeBytes: 40,
        stateVersion: 1,
      },
    );
    sessions.pinPart.mockResolvedValue({
      part: {
        checksum: { algorithm: 'SHA256', value: checksum },
        createdAt: now,
        partNumber: 3,
        sizeBytes: 8,
        tenantId: multipart.tenantId,
        uploadSessionId: multipart.id,
      },
      session: multipart,
    });
    storage.createMultipartPartCapability.mockResolvedValue({
      expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
      headers: { 'x-amz-checksum-sha256': checksum },
      method: 'PUT',
      url: 'https://storage.example/part',
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      idGenerator(),
    );
    const request = {
      actor: input.actor,
      causationId: input.causationId,
      checksumValue: checksum,
      contentLength: 8,
      correlationId: input.correlationId,
      partNumber: 3,
      tenantId: input.tenantId,
      uploadSessionId: multipart.id,
    };

    await expect(
      service.issueMultipartPartCapability(request),
    ).resolves.toMatchObject({
      method: 'PUT',
      url: 'https://storage.example/part',
    });
    expect(sessions.pinPart).toHaveBeenCalledWith(request);
    expect(storage.createMultipartPartCapability).toHaveBeenCalledWith({
      checksumValue: checksum,
      contentLength: 8,
      expiresInSeconds: 15 * 60,
      partNumber: 3,
      storageObjectId: multipart.storageObjectId,
      tenantId: multipart.tenantId,
      uploadReference: 'internal-reference',
    });
  });

  it('verifies a single upload before committing its document and execution', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const active = session();
    const metadata = storedMetadata(active);
    const completed = {
      ...active,
      completedAt: now,
      documentId: completionIds[0],
      executionId: completionIds[1],
      stateVersion: 1,
      status: 'COMPLETED' as const,
    };
    sessions.findById.mockResolvedValue(active);
    storage.inspectUpload.mockResolvedValue(metadata);
    sessions.commitCompletion.mockResolvedValue({
      documentId: completionIds[0]!,
      executionId: completionIds[1]!,
      session: completed,
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      completionIdGenerator(),
    );

    await expect(service.complete(completeInput)).resolves.toEqual({
      documentId: completionIds[0],
      executionId: completionIds[1],
      uploadSessionId: active.id,
    });
    expect(storage.inspectUpload).toHaveBeenCalledWith({
      storageObjectId: active.storageObjectId,
      tenantId: active.tenantId,
    });
    expect(sessions.commitCompletion).toHaveBeenCalledWith({
      ...completeInput,
      documentId: completionIds[0],
      executionId: completionIds[1],
      metadata,
    });
  });

  it('completes multipart storage only from exact durable part receipts', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const active = session(
      { partCount: 2, partSizeBytes: 16, type: 'MULTIPART' },
      {
        multipartUploadReference: 'internal-reference',
        sizeBytes: 24,
        stateVersion: 1,
      },
    );
    const partChecksums = [
      Buffer.alloc(32, 5).toString('base64'),
      Buffer.alloc(32, 6).toString('base64'),
    ];
    const pinned = partChecksums.map((value, index) => ({
      checksum: { algorithm: 'SHA256' as const, value },
      createdAt: now,
      partNumber: index + 1,
      sizeBytes: index === 0 ? 16 : 8,
      tenantId: active.tenantId,
      uploadSessionId: active.id,
    }));
    const metadata = storedMetadata(active, {
      checksum: {
        algorithm: 'SHA256',
        type: 'COMPOSITE',
        value: compositeSha256Checksum(partChecksums),
      },
      versionId: 'multipart-version-1',
    });
    const receipts = pinned.map((part) => ({
      checksumValue: part.checksum.value,
      etag: `etag-${part.partNumber}`,
      partNumber: part.partNumber,
    }));
    sessions.findById.mockResolvedValue(active);
    sessions.findParts.mockResolvedValue(pinned);
    storage.inspectUpload
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(metadata);
    storage.completeMultipartUpload.mockResolvedValue({
      checksum: metadata.checksum,
      versionId: metadata.versionId,
    });
    sessions.commitCompletion.mockResolvedValue({
      documentId: completionIds[0]!,
      executionId: completionIds[1]!,
      session: {
        ...active,
        completedAt: now,
        documentId: completionIds[0],
        executionId: completionIds[1],
        stateVersion: 2,
        status: 'COMPLETED',
      },
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      completionIdGenerator(),
    );

    await expect(
      service.complete({ ...completeInput, parts: receipts }),
    ).resolves.toMatchObject({
      documentId: completionIds[0],
      executionId: completionIds[1],
    });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith({
      parts: receipts,
      sizeBytes: active.sizeBytes,
      storageObjectId: active.storageObjectId,
      tenantId: active.tenantId,
      uploadReference: 'internal-reference',
    });
    expect(storage.inspectUpload).toHaveBeenLastCalledWith({
      storageObjectId: active.storageObjectId,
      tenantId: active.tenantId,
      versionId: 'multipart-version-1',
    });
  });

  it('reconciles an uncertain multipart completion by inspecting the current object', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const active = session(
      { partCount: 2, partSizeBytes: 16, type: 'MULTIPART' },
      {
        multipartUploadReference: 'internal-reference',
        sizeBytes: 24,
        stateVersion: 1,
      },
    );
    const partChecksums = [
      Buffer.alloc(32, 5).toString('base64'),
      Buffer.alloc(32, 6).toString('base64'),
    ];
    const pinned = partChecksums.map((value, index) => ({
      checksum: { algorithm: 'SHA256' as const, value },
      createdAt: now,
      partNumber: index + 1,
      sizeBytes: index === 0 ? 16 : 8,
      tenantId: active.tenantId,
      uploadSessionId: active.id,
    }));
    const metadata = storedMetadata(active, {
      checksum: {
        algorithm: 'SHA256',
        type: 'COMPOSITE',
        value: compositeSha256Checksum(partChecksums),
      },
      versionId: 'multipart-version-1',
    });
    sessions.findById.mockResolvedValue(active);
    sessions.findParts.mockResolvedValue(pinned);
    storage.inspectUpload
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(metadata);
    storage.completeMultipartUpload.mockRejectedValue(
      new Error('STORAGE_COMPLETION_RESPONSE_LOST'),
    );
    sessions.commitCompletion.mockResolvedValue({
      documentId: completionIds[0]!,
      executionId: completionIds[1]!,
      session: active,
    });
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      completionIdGenerator(),
    );
    const receipts = pinned.map((part) => ({
      checksumValue: part.checksum.value,
      etag: `etag-${part.partNumber}`,
      partNumber: part.partNumber,
    }));

    await expect(
      service.complete({ ...completeInput, parts: receipts }),
    ).resolves.toMatchObject({ documentId: completionIds[0] });
    expect(sessions.commitCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ metadata }),
    );
  });

  it('rejects changed multipart receipts before completing storage', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const active = session(
      { partCount: 2, partSizeBytes: 16, type: 'MULTIPART' },
      {
        multipartUploadReference: 'internal-reference',
        sizeBytes: 24,
        stateVersion: 1,
      },
    );
    const pinned = [1, 2].map((partNumber) => ({
      checksum: {
        algorithm: 'SHA256' as const,
        value: Buffer.alloc(32, partNumber).toString('base64'),
      },
      createdAt: now,
      partNumber,
      sizeBytes: partNumber === 1 ? 16 : 8,
      tenantId: active.tenantId,
      uploadSessionId: active.id,
    }));
    sessions.findById.mockResolvedValue(active);
    sessions.findParts.mockResolvedValue(pinned);
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      completionIdGenerator(),
    );

    await expect(
      service.complete({
        ...completeInput,
        parts: pinned.map((part) => ({
          checksumValue: part.partNumber === 2 ? checksum : part.checksum.value,
          etag: `etag-${part.partNumber}`,
          partNumber: part.partNumber,
        })),
      }),
    ).rejects.toThrow(
      new DirectUploadApplicationError('UPLOAD_COMPLETION_PARTS_INVALID'),
    );
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(sessions.commitCompletion).not.toHaveBeenCalled();
  });

  it('does not commit metadata that differs from the upload contract', async () => {
    const sessions = repository();
    const storage = objectStorage();
    const active = session();
    sessions.findById.mockResolvedValue(active);
    storage.inspectUpload.mockResolvedValue(
      storedMetadata(active, { sizeBytes: active.sizeBytes + 1 }),
    );
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      completionIdGenerator(),
    );

    await expect(service.complete(completeInput)).rejects.toThrow(
      new DirectUploadApplicationError('UPLOAD_INTEGRITY_MISMATCH'),
    );
    expect(sessions.commitCompletion).not.toHaveBeenCalled();
  });

  it('returns the durable completion without touching storage again', async () => {
    const sessions = repository();
    const storage = objectStorage();
    sessions.findById.mockResolvedValue(
      session(undefined, {
        completedAt: now,
        documentId: completionIds[0],
        executionId: completionIds[1],
        stateVersion: 1,
        status: 'COMPLETED',
      }),
    );
    const service = new DirectUploadService(
      sessions,
      storage,
      DEFAULT_DIRECT_UPLOAD_POLICY,
      () => now,
      completionIdGenerator(),
    );

    await expect(service.complete(completeInput)).resolves.toEqual({
      documentId: completionIds[0],
      executionId: completionIds[1],
      uploadSessionId: ids[1],
    });
    expect(storage.inspectUpload).not.toHaveBeenCalled();
    expect(sessions.commitCompletion).not.toHaveBeenCalled();
  });
});
