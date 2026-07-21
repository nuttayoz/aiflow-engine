import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ClaimedExecutionStage } from '@aiflow/executions';
import type { ObjectStoragePort } from '@aiflow/storage';

import {
  type BusinessCentralDeliveryRepository,
  BusinessCentralDeliveryProcessor,
} from './processor';
import { FakeBusinessCentralDestination } from './index';
import type { BusinessCentralDestinationPort } from './index';

const payload = {
  currencyCode: 'THB',
  invoiceDate: '2026-07-21',
  totalAmount: '1250.50',
  vendorInvoiceNumber: 'INV-1',
  vendorNumber: 'V-10000',
};
const payloadSha256 = createHash('sha256')
  .update(JSON.stringify(payload))
  .digest('hex');
const artifact = Buffer.from(
  JSON.stringify({ data: payload, payloadSha256, schemaVersion: 1 }),
);
const operation = {
  actionId: 'create-purchase-invoice-draft',
  actionVersion: 1,
  companyResourceId: 'company-1',
  connectorId: 'microsoft-business-central',
  currentExecutionId: 'execution-1',
  effectKey: 'effect-1',
  id: 'operation-1',
  input: {
    checksum: {
      algorithm: 'SHA256' as const,
      type: 'FULL_OBJECT' as const,
      value: createHash('sha256').update(artifact).digest('base64'),
    },
    key: 'objects/tenant-1/artifact',
    versionId: 'version-1',
  },
  inputSchemaVersion: 1,
  payloadSha256,
  reconciliationDeadlineAt: new Date('2026-07-21T01:00:00.000Z'),
  stateVersion: 0,
  status: 'READY' as const,
  tenantId: 'tenant-1',
};
const claimed = {
  attempt: {
    attemptId: 'attempt-1',
    attemptNumber: 1,
    executionId: 'execution-1',
    leaseExpiresAt: new Date('2026-07-21T00:05:00.000Z'),
    leaseOwner: 'worker-1',
    stage: 'DELIVER',
    startedAt: new Date('2026-07-21T00:00:00.000Z'),
    status: 'RUNNING',
    tenantId: 'tenant-1',
  },
  execution: {
    executionId: 'execution-1',
    stateVersion: 3,
    tenantId: 'tenant-1',
  },
} as unknown as ClaimedExecutionStage;

const storage = {
  readExactVersion: jest.fn().mockImplementation(() => Readable.from(artifact)),
} as unknown as ObjectStoragePort;

describe('BusinessCentralDeliveryProcessor', () => {
  it('reconciles a timeout after apply without creating a second effect', async () => {
    let current: NonNullable<
      Awaited<ReturnType<BusinessCentralDeliveryRepository['findDelivery']>>
    > = operation;
    const repository = {
      completeUnknownDelivery: jest.fn(),
      findDelivery: jest.fn().mockImplementation(() => current),
      markDeliveryUnknown: jest.fn().mockImplementation(() => {
        current = { ...current, status: 'UNKNOWN' };
      }),
      startDelivery: jest.fn().mockImplementation(() => {
        current = { ...current, stateVersion: 1, status: 'SUBMITTING' };
        return current;
      }),
    } as unknown as BusinessCentralDeliveryRepository;
    const destination = new FakeBusinessCentralDestination(
      'TIMEOUT_AFTER_APPLY',
      () => new Date('2026-07-21T00:00:00.000Z'),
    );
    const processor = new BusinessCentralDeliveryProcessor(
      repository,
      storage,
      destination,
      () => new Date('2026-07-21T00:00:10.000Z'),
    );

    await expect(processor.process(claimed, 'message-1')).resolves.toBe(
      'WAITING',
    );
    await expect(
      processor.reconcile({
        causationId: 'message-2',
        executionId: 'execution-1',
        expectedStateVersion: 4,
        tenantId: 'tenant-1',
      }),
    ).resolves.toBe('COMPLETED');
    expect(repository.completeUnknownDelivery).toHaveBeenCalledTimes(1);
    expect(destination.effectCount()).toBe(1);
  });

  it('schedules a safe retry when the destination confirms no write', async () => {
    const repository = {
      findDelivery: jest.fn().mockResolvedValue(operation),
      scheduleDeliveryRetry: jest.fn(),
      startDelivery: jest.fn().mockResolvedValue({
        ...operation,
        stateVersion: 1,
        status: 'SUBMITTING',
      }),
    } as unknown as BusinessCentralDeliveryRepository;
    const processor = new BusinessCentralDeliveryProcessor(
      repository,
      storage,
      new FakeBusinessCentralDestination('THROTTLE'),
    );

    await expect(processor.process(claimed, 'message-1')).resolves.toBe(
      'WAITING',
    );
    expect(repository.scheduleDeliveryRetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DESTINATION_THROTTLED' }),
    );
  });

  it('fails safely at the reconciliation deadline instead of blind replay', async () => {
    const repository = {
      failUnknownDelivery: jest.fn(),
      findDelivery: jest.fn().mockResolvedValue({
        ...operation,
        reconciliationDeadlineAt: new Date('2026-07-21T00:00:00.000Z'),
        status: 'UNKNOWN',
      }),
    } as unknown as BusinessCentralDeliveryRepository;
    const destination = {
      lookup: jest.fn().mockResolvedValue({ status: 'UNKNOWN' }),
    } as unknown as BusinessCentralDestinationPort;
    const processor = new BusinessCentralDeliveryProcessor(
      repository,
      storage,
      destination,
      () => new Date('2026-07-21T00:00:01.000Z'),
    );

    await expect(
      processor.reconcile({
        causationId: 'message-2',
        executionId: 'execution-1',
        expectedStateVersion: 4,
        tenantId: 'tenant-1',
      }),
    ).resolves.toBe('FAILED');
    expect(repository.failUnknownDelivery).toHaveBeenCalledTimes(1);
    expect(destination.lookup).toHaveBeenCalledTimes(1);
  });
});
