import type { ActorIdentity } from '@aiflow/core';

import type {
  ExecutionRecord,
  ExecutionStage,
  SafeExecutionFailure,
  StageAttemptRecord,
} from './types';

export interface CreateExecutionInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly documentId: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly reviewRequired: boolean;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export interface ClaimExecutionStageInput {
  readonly consumerName: string;
  readonly expectedStateVersion: number;
  readonly executionId: string;
  readonly leaseDurationMs: number;
  readonly leaseOwner: string;
  readonly messageId: string;
  readonly messageType: string;
  readonly projectId: string;
  readonly stage: ExecutionStage;
  readonly tenantId: string;
}

export interface ClaimedExecutionStage {
  readonly attempt: StageAttemptRecord;
  readonly execution: ExecutionRecord;
}

export interface CompleteExecutionStageInput {
  readonly causationId: string;
  readonly executionId: string;
  readonly expectedStateVersion: number;
  readonly leaseOwner: string;
  readonly outputSchemaVersion?: number;
  readonly outputStorageObjectId?: string;
  readonly stage: ExecutionStage;
  readonly tenantId: string;
}

export interface ScheduleExecutionRetryInput {
  readonly executionId: string;
  readonly expectedStateVersion: number;
  readonly failure: SafeExecutionFailure;
  readonly leaseOwner: string;
  readonly nextAttemptAt: Date;
  readonly stage: ExecutionStage;
  readonly tenantId: string;
}

export interface ExecutionRepository {
  claimStage(
    input: ClaimExecutionStageInput,
  ): Promise<ClaimedExecutionStage | undefined>;
  completeStage(input: CompleteExecutionStageInput): Promise<ExecutionRecord>;
  create(input: CreateExecutionInput): Promise<ExecutionRecord>;
  findById(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionRecord | undefined>;
  scheduleRetry(input: ScheduleExecutionRetryInput): Promise<ExecutionRecord>;
}

export interface RecoveryBatchResult {
  readonly processed: number;
}

export interface ExecutionRecoveryRepository {
  enqueueDueRetries(batchSize: number): Promise<RecoveryBatchResult>;
  recoverExpiredLeases(
    batchSize: number,
    retryDelayMs: number,
  ): Promise<RecoveryBatchResult>;
}

export interface SchedulerLeaseRecord {
  readonly fencingVersion: number;
  readonly jobName: string;
  readonly leaseExpiresAt: Date;
  readonly leaseOwner: string;
}

export interface SchedulerLeaseRepository {
  acquire(input: {
    readonly durationMs: number;
    readonly jobName: string;
    readonly owner: string;
  }): Promise<SchedulerLeaseRecord | undefined>;
}
