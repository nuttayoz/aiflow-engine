import type { ActorIdentity } from '@aiflow/core';

export const EXECUTION_STAGES = [
  'EXTRACT',
  'MAP',
  'REVIEW',
  'DELIVER',
] as const;
export const EXECUTION_STATUSES = [
  'QUEUED',
  'EXTRACTING',
  'MAPPING',
  'AWAITING_REVIEW',
  'DELIVERING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
] as const;
export const EXECUTION_STAGE_STATUSES = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
] as const;
export const FAILURE_CATEGORIES = [
  'TRANSIENT',
  'PERMANENT',
  'UNKNOWN_OUTCOME',
  'POLICY',
] as const;

export type ExecutionStage = (typeof EXECUTION_STAGES)[number];
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type ExecutionStageStatus = (typeof EXECUTION_STAGE_STATUSES)[number];
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
export type AttemptStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

export interface SafeExecutionFailure {
  readonly category: FailureCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecutionStageSnapshot {
  readonly attemptCount: number;
  readonly failure?: SafeExecutionFailure;
  readonly leaseExpiresAt?: Date;
  readonly leaseOwner?: string;
  readonly nextAttemptAt?: Date;
  readonly stage: ExecutionStage;
  readonly stateVersion: number;
  readonly status: ExecutionStageStatus;
}

export interface ExecutionLifecycle {
  readonly currentStage: ExecutionStage;
  readonly failure?: SafeExecutionFailure;
  readonly reviewRequired: boolean;
  readonly stages: Readonly<Record<ExecutionStage, ExecutionStageSnapshot>>;
  readonly stateVersion: number;
  readonly status: ExecutionStatus;
}

export interface ExecutionRecord extends ExecutionLifecycle {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly completedAt?: Date;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly documentId: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly retryOfExecutionId?: string;
  readonly rootExecutionId: string;
  readonly tenantId: string;
  readonly transitionedAt: Date;
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export interface StageAttemptRecord {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly executionId: string;
  readonly failure?: SafeExecutionFailure;
  readonly finishedAt?: Date;
  readonly leaseExpiresAt: Date;
  readonly leaseOwner: string;
  readonly outputSchemaVersion?: number;
  readonly outputStorageObjectId?: string;
  readonly stage: ExecutionStage;
  readonly startedAt: Date;
  readonly status: AttemptStatus;
  readonly tenantId: string;
}
