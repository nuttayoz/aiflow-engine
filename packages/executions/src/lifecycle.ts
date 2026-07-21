import type {
  ExecutionLifecycle,
  ExecutionStage,
  ExecutionStageSnapshot,
  ExecutionStatus,
  SafeExecutionFailure,
} from './types';

export type ExecutionTransitionErrorCode =
  | 'EXECUTION_TERMINAL'
  | 'LEASE_MISMATCH'
  | 'RETRY_NOT_DUE'
  | 'STAGE_NOT_ELIGIBLE'
  | 'STAGE_OUT_OF_ORDER'
  | 'STATE_VERSION_MISMATCH';

export class ExecutionTransitionError extends Error {
  constructor(readonly code: ExecutionTransitionErrorCode) {
    super(code);
    this.name = 'ExecutionTransitionError';
  }
}

const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
];

const activeStatus = (stage: ExecutionStage): ExecutionStatus => {
  switch (stage) {
    case 'EXTRACT':
      return 'EXTRACTING';
    case 'MAP':
      return 'MAPPING';
    case 'REVIEW':
      return 'AWAITING_REVIEW';
    case 'DELIVER':
      return 'DELIVERING';
  }
};

const emptyStage = (
  stage: ExecutionStage,
  status: ExecutionStageSnapshot['status'] = 'PENDING',
): ExecutionStageSnapshot => ({
  attemptCount: 0,
  stage,
  stateVersion: 0,
  status,
});

export const createExecutionLifecycle = (
  reviewRequired: boolean,
): ExecutionLifecycle => ({
  currentStage: 'EXTRACT',
  reviewRequired,
  stages: {
    DELIVER: emptyStage('DELIVER'),
    EXTRACT: emptyStage('EXTRACT'),
    MAP: emptyStage('MAP'),
    REVIEW: emptyStage('REVIEW', reviewRequired ? 'PENDING' : 'SKIPPED'),
  },
  stateVersion: 0,
  status: 'QUEUED',
});

const requireMutable = (
  lifecycle: ExecutionLifecycle,
  expectedStateVersion: number,
  stage: ExecutionStage,
): ExecutionStageSnapshot => {
  if (TERMINAL_STATUSES.includes(lifecycle.status)) {
    throw new ExecutionTransitionError('EXECUTION_TERMINAL');
  }
  if (lifecycle.stateVersion !== expectedStateVersion) {
    throw new ExecutionTransitionError('STATE_VERSION_MISMATCH');
  }
  if (lifecycle.currentStage !== stage) {
    throw new ExecutionTransitionError('STAGE_OUT_OF_ORDER');
  }

  return lifecycle.stages[stage];
};

const replaceStage = (
  lifecycle: ExecutionLifecycle,
  stage: ExecutionStage,
  replacement: ExecutionStageSnapshot,
  execution: Partial<ExecutionLifecycle>,
): ExecutionLifecycle => ({
  ...lifecycle,
  ...execution,
  stages: { ...lifecycle.stages, [stage]: replacement },
  stateVersion: lifecycle.stateVersion + 1,
});

export interface ClaimStageInput {
  readonly expectedStateVersion: number;
  readonly leaseExpiresAt: Date;
  readonly leaseOwner: string;
  readonly now: Date;
  readonly stage: ExecutionStage;
}

export const claimExecutionStage = (
  lifecycle: ExecutionLifecycle,
  input: ClaimStageInput,
): ExecutionLifecycle => {
  const current = requireMutable(
    lifecycle,
    input.expectedStateVersion,
    input.stage,
  );

  if (current.status !== 'PENDING' && current.status !== 'RETRY_SCHEDULED') {
    throw new ExecutionTransitionError('STAGE_NOT_ELIGIBLE');
  }
  if (
    current.status === 'RETRY_SCHEDULED' &&
    current.nextAttemptAt !== undefined &&
    current.nextAttemptAt.getTime() > input.now.getTime()
  ) {
    throw new ExecutionTransitionError('RETRY_NOT_DUE');
  }
  if (input.leaseExpiresAt.getTime() <= input.now.getTime()) {
    throw new ExecutionTransitionError('LEASE_MISMATCH');
  }

  return replaceStage(
    lifecycle,
    input.stage,
    {
      attemptCount: current.attemptCount + 1,
      leaseExpiresAt: new Date(input.leaseExpiresAt),
      leaseOwner: input.leaseOwner,
      stage: input.stage,
      stateVersion: current.stateVersion + 1,
      status: 'RUNNING',
    },
    { status: activeStatus(input.stage) },
  );
};

export interface CompleteStageInput {
  readonly expectedStateVersion: number;
  readonly leaseOwner: string;
  readonly stage: ExecutionStage;
}

export const completeExecutionStage = (
  lifecycle: ExecutionLifecycle,
  input: CompleteStageInput,
): ExecutionLifecycle => {
  const current = requireMutable(
    lifecycle,
    input.expectedStateVersion,
    input.stage,
  );

  if (current.status !== 'RUNNING') {
    throw new ExecutionTransitionError('STAGE_NOT_ELIGIBLE');
  }
  if (current.leaseOwner !== input.leaseOwner) {
    throw new ExecutionTransitionError('LEASE_MISMATCH');
  }

  const completed: ExecutionStageSnapshot = {
    attemptCount: current.attemptCount,
    stage: input.stage,
    stateVersion: current.stateVersion + 1,
    status: 'SUCCEEDED',
  };

  switch (input.stage) {
    case 'EXTRACT':
      return replaceStage(lifecycle, input.stage, completed, {
        currentStage: 'MAP',
        status: 'MAPPING',
      });
    case 'MAP':
      return replaceStage(lifecycle, input.stage, completed, {
        currentStage: lifecycle.reviewRequired ? 'REVIEW' : 'DELIVER',
        status: lifecycle.reviewRequired ? 'AWAITING_REVIEW' : 'DELIVERING',
      });
    case 'REVIEW':
      return replaceStage(lifecycle, input.stage, completed, {
        currentStage: 'DELIVER',
        status: 'DELIVERING',
      });
    case 'DELIVER':
      return replaceStage(lifecycle, input.stage, completed, {
        status: 'SUCCEEDED',
      });
  }
};

export interface ScheduleRetryInput {
  readonly expectedStateVersion: number;
  readonly failure: SafeExecutionFailure;
  readonly leaseOwner: string;
  readonly nextAttemptAt: Date;
  readonly now: Date;
  readonly stage: ExecutionStage;
}

export const scheduleExecutionStageRetry = (
  lifecycle: ExecutionLifecycle,
  input: ScheduleRetryInput,
): ExecutionLifecycle => {
  const current = requireMutable(
    lifecycle,
    input.expectedStateVersion,
    input.stage,
  );

  if (current.status !== 'RUNNING') {
    throw new ExecutionTransitionError('STAGE_NOT_ELIGIBLE');
  }
  if (current.leaseOwner !== input.leaseOwner) {
    throw new ExecutionTransitionError('LEASE_MISMATCH');
  }
  if (
    !input.failure.retryable ||
    input.failure.category !== 'TRANSIENT' ||
    input.nextAttemptAt.getTime() <= input.now.getTime()
  ) {
    throw new ExecutionTransitionError('RETRY_NOT_DUE');
  }

  return replaceStage(
    lifecycle,
    input.stage,
    {
      attemptCount: current.attemptCount,
      failure: input.failure,
      nextAttemptAt: new Date(input.nextAttemptAt),
      stage: input.stage,
      stateVersion: current.stateVersion + 1,
      status: 'RETRY_SCHEDULED',
    },
    { failure: input.failure },
  );
};

export interface FailExecutionInput {
  readonly expectedStateVersion: number;
  readonly failure: SafeExecutionFailure;
  readonly leaseOwner: string;
  readonly stage: ExecutionStage;
}

export const failExecution = (
  lifecycle: ExecutionLifecycle,
  input: FailExecutionInput,
): ExecutionLifecycle => {
  const current = requireMutable(
    lifecycle,
    input.expectedStateVersion,
    input.stage,
  );

  if (current.status !== 'RUNNING') {
    throw new ExecutionTransitionError('STAGE_NOT_ELIGIBLE');
  }
  if (current.leaseOwner !== input.leaseOwner) {
    throw new ExecutionTransitionError('LEASE_MISMATCH');
  }

  return replaceStage(
    lifecycle,
    input.stage,
    {
      attemptCount: current.attemptCount,
      failure: input.failure,
      stage: input.stage,
      stateVersion: current.stateVersion + 1,
      status: 'FAILED',
    },
    { failure: input.failure, status: 'FAILED' },
  );
};
