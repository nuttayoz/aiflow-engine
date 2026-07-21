import { createHash } from 'node:crypto';

import type { ClaimedExecutionStage } from '@aiflow/executions';
import { readBoundedJson } from '@aiflow/mappings';
import type { ObjectStoragePort } from '@aiflow/storage';

import {
  type BusinessCentralDestinationPort,
  type BusinessCentralReceipt,
  isPurchaseInvoiceDraftInput,
} from './index';

interface DeliveryStorageReference {
  readonly checksum: {
    readonly algorithm: 'SHA256';
    readonly type: 'COMPOSITE' | 'FULL_OBJECT';
    readonly value: string;
  };
  readonly key: string;
  readonly versionId: string;
}

interface DeliveryOperation {
  readonly actionId: string;
  readonly actionVersion: number;
  readonly companyResourceId: string;
  readonly connectorId: string;
  readonly currentExecutionId: string;
  readonly effectKey: string;
  readonly id: string;
  readonly input: DeliveryStorageReference;
  readonly inputSchemaVersion: number;
  readonly payloadSha256: string;
  readonly reconciliationDeadlineAt: Date;
  readonly stateVersion: number;
  readonly status: 'APPLIED' | 'FAILED' | 'READY' | 'SUBMITTING' | 'UNKNOWN';
  readonly tenantId: string;
}

export interface BusinessCentralDeliveryRepository {
  completeDelivery(
    input: DeliveryCompletionInput & {
      readonly leaseOwner: string;
    },
  ): Promise<void>;
  completeUnknownDelivery(input: DeliveryCompletionInput): Promise<void>;
  deferDeliveryReconciliation(input: {
    readonly nextCheckAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void>;
  failDelivery(input: {
    readonly causationId: string;
    readonly code: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void>;
  failUnknownDelivery(input: {
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void>;
  findDelivery(
    tenantId: string,
    executionId: string,
  ): Promise<DeliveryOperation | undefined>;
  markDeliveryUnknown(input: {
    readonly causationId: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void>;
  resetUnknownDelivery(input: {
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void>;
  scheduleDeliveryRetry(input: {
    readonly causationId: string;
    readonly code: string;
    readonly executionId: string;
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<void>;
  startDelivery(input: {
    readonly executionId: string;
    readonly expectedOperationStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<DeliveryOperation>;
}

interface DeliveryCompletionInput {
  readonly appliedAt: Date;
  readonly causationId: string;
  readonly executionId: string;
  readonly expectedStateVersion: number;
  readonly externalResourceId: string;
  readonly externalResourceNumber: string;
  readonly externalResourceType: string;
  readonly externalVersion: string;
  readonly operationId: string;
  readonly tenantId: string;
}

interface ReconcileDeliveryInput {
  readonly causationId: string;
  readonly executionId: string;
  readonly expectedStateVersion: number;
  readonly tenantId: string;
}

const payloadFromArtifact = (
  value: unknown,
  operation: DeliveryOperation,
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DESTINATION_ARTIFACT_INVALID');
  }
  const artifact = value as Readonly<Record<string, unknown>>;
  const data = artifact.data;
  if (
    artifact.schemaVersion !== operation.inputSchemaVersion ||
    artifact.payloadSha256 !== operation.payloadSha256 ||
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    createHash('sha256').update(JSON.stringify(data)).digest('hex') !==
      operation.payloadSha256
  ) {
    throw new Error('DESTINATION_ARTIFACT_INVALID');
  }
  return data as Readonly<Record<string, unknown>>;
};

const completion = (
  input: ReconcileDeliveryInput,
  operation: DeliveryOperation,
  receipt: BusinessCentralReceipt,
): DeliveryCompletionInput => ({
  appliedAt: receipt.appliedAt,
  causationId: input.causationId,
  executionId: input.executionId,
  expectedStateVersion: input.expectedStateVersion,
  externalResourceId: receipt.externalResourceId,
  externalResourceNumber: receipt.externalResourceNumber,
  externalResourceType: receipt.externalResourceType,
  externalVersion: receipt.externalVersion,
  operationId: operation.id,
  tenantId: input.tenantId,
});

type Clock = () => Date;

export class BusinessCentralDeliveryProcessor {
  constructor(
    private readonly repository: BusinessCentralDeliveryRepository,
    private readonly storage: ObjectStoragePort,
    private readonly destination: BusinessCentralDestinationPort,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async process(
    claimed: ClaimedExecutionStage,
    causationId: string,
  ): Promise<'COMPLETED' | 'FAILED' | 'WAITING'> {
    const operation = await this.requireOperation(
      claimed.execution.tenantId,
      claimed.execution.executionId,
    );
    if (
      operation.connectorId !== 'microsoft-business-central' ||
      operation.actionId !== 'create-purchase-invoice-draft' ||
      operation.actionVersion !== 1 ||
      operation.status !== 'READY'
    ) {
      throw new Error('DELIVERY_OPERATION_INVALID');
    }
    const stream = await this.storage.readExactVersion({
      expectedChecksum: operation.input.checksum,
      key: operation.input.key,
      versionId: operation.input.versionId,
    });
    const payload = payloadFromArtifact(
      await readBoundedJson(stream),
      operation,
    );
    if (!isPurchaseInvoiceDraftInput(payload)) {
      await this.repository.failDelivery({
        causationId,
        code: 'DESTINATION_INPUT_INVALID',
        executionId: claimed.execution.executionId,
        expectedStateVersion: claimed.execution.stateVersion,
        leaseOwner: claimed.attempt.leaseOwner,
        operationId: operation.id,
        tenantId: claimed.execution.tenantId,
      });
      return 'FAILED';
    }
    const submitting = await this.repository.startDelivery({
      executionId: claimed.execution.executionId,
      expectedOperationStateVersion: operation.stateVersion,
      leaseOwner: claimed.attempt.leaseOwner,
      operationId: operation.id,
      tenantId: claimed.execution.tenantId,
    });
    try {
      const result = await this.destination.apply({
        companyResourceId: submitting.companyResourceId,
        effectKey: submitting.effectKey,
        payload,
        payloadSha256: submitting.payloadSha256,
      });
      if (result.status === 'APPLIED') {
        await this.repository.completeDelivery({
          ...completion(
            {
              causationId,
              executionId: claimed.execution.executionId,
              expectedStateVersion: claimed.execution.stateVersion,
              tenantId: claimed.execution.tenantId,
            },
            submitting,
            result.receipt,
          ),
          leaseOwner: claimed.attempt.leaseOwner,
        });
        return 'COMPLETED';
      }
      if (result.status === 'FAILED') {
        await this.repository.failDelivery({
          causationId,
          code: result.code,
          executionId: claimed.execution.executionId,
          expectedStateVersion: claimed.execution.stateVersion,
          leaseOwner: claimed.attempt.leaseOwner,
          operationId: submitting.id,
          tenantId: claimed.execution.tenantId,
        });
        return 'FAILED';
      }
      await this.repository.scheduleDeliveryRetry({
        causationId,
        code: result.code,
        executionId: claimed.execution.executionId,
        expectedStateVersion: claimed.execution.stateVersion,
        leaseOwner: claimed.attempt.leaseOwner,
        nextAttemptAt: result.retryAfter,
        operationId: submitting.id,
        tenantId: claimed.execution.tenantId,
      });
      return 'WAITING';
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'DESTINATION_WRITE_OUTCOME_UNKNOWN'
      ) {
        throw error;
      }
      await this.repository.markDeliveryUnknown({
        causationId,
        executionId: claimed.execution.executionId,
        expectedStateVersion: claimed.execution.stateVersion,
        leaseOwner: claimed.attempt.leaseOwner,
        operationId: submitting.id,
        tenantId: claimed.execution.tenantId,
      });
      return 'WAITING';
    }
  }

  async reconcile(
    input: ReconcileDeliveryInput,
  ): Promise<'COMPLETED' | 'FAILED' | 'WAITING'> {
    const operation = await this.requireOperation(
      input.tenantId,
      input.executionId,
    );
    if (operation.status !== 'UNKNOWN') {
      return 'WAITING';
    }
    const result = await this.destination.lookup({
      companyResourceId: operation.companyResourceId,
      effectKey: operation.effectKey,
      payloadSha256: operation.payloadSha256,
    });
    if (result.status === 'APPLIED') {
      await this.repository.completeUnknownDelivery(
        completion(input, operation, result.receipt),
      );
      return 'COMPLETED';
    }
    const now = this.clock();
    if (result.status === 'NOT_APPLIED') {
      await this.repository.resetUnknownDelivery({
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        nextAttemptAt: new Date(now.getTime() + 1_000),
        operationId: operation.id,
        tenantId: input.tenantId,
      });
      return 'WAITING';
    }
    if (now.getTime() >= operation.reconciliationDeadlineAt.getTime()) {
      await this.repository.failUnknownDelivery({
        causationId: input.causationId,
        executionId: input.executionId,
        expectedStateVersion: input.expectedStateVersion,
        operationId: operation.id,
        tenantId: input.tenantId,
      });
      return 'FAILED';
    }
    await this.repository.deferDeliveryReconciliation({
      nextCheckAt: new Date(now.getTime() + 30_000),
      operationId: operation.id,
      tenantId: input.tenantId,
    });
    return 'WAITING';
  }

  private async requireOperation(
    tenantId: string,
    executionId: string,
  ): Promise<DeliveryOperation> {
    const operation = await this.repository.findDelivery(tenantId, executionId);
    if (operation === undefined) {
      throw new Error('DELIVERY_OPERATION_NOT_FOUND');
    }
    return operation;
  }
}
