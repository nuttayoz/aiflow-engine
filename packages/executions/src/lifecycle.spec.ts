import {
  claimExecutionStage,
  completeExecutionStage,
  createExecutionLifecycle,
  ExecutionTransitionError,
  failExecution,
  scheduleExecutionStageRetry,
} from './lifecycle';

const now = new Date('2026-07-20T00:00:00.000Z');
const leaseExpiresAt = new Date('2026-07-20T00:01:00.000Z');

describe('execution lifecycle', () => {
  it('moves through the provider-neutral stages and skips optional review', () => {
    let lifecycle = createExecutionLifecycle(false);

    for (const stage of ['EXTRACT', 'MAP', 'DELIVER'] as const) {
      lifecycle = claimExecutionStage(lifecycle, {
        expectedStateVersion: lifecycle.stateVersion,
        leaseExpiresAt,
        leaseOwner: 'worker-1',
        now,
        stage,
      });
      lifecycle = completeExecutionStage(lifecycle, {
        expectedStateVersion: lifecycle.stateVersion,
        leaseOwner: 'worker-1',
        stage,
      });
    }

    expect(lifecycle.status).toBe('SUCCEEDED');
    expect(lifecycle.stages.REVIEW.status).toBe('SKIPPED');
    expect(lifecycle.stateVersion).toBe(6);
  });

  it('rejects duplicate and out-of-order commands', () => {
    const lifecycle = createExecutionLifecycle(true);
    const claimed = claimExecutionStage(lifecycle, {
      expectedStateVersion: 0,
      leaseExpiresAt,
      leaseOwner: 'worker-1',
      now,
      stage: 'EXTRACT',
    });

    expect(() =>
      claimExecutionStage(claimed, {
        expectedStateVersion: 0,
        leaseExpiresAt,
        leaseOwner: 'worker-2',
        now,
        stage: 'EXTRACT',
      }),
    ).toThrow(new ExecutionTransitionError('STATE_VERSION_MISMATCH'));
    expect(() =>
      claimExecutionStage(lifecycle, {
        expectedStateVersion: 0,
        leaseExpiresAt,
        leaseOwner: 'worker-1',
        now,
        stage: 'MAP',
      }),
    ).toThrow(new ExecutionTransitionError('STAGE_OUT_OF_ORDER'));
  });

  it('persists retry eligibility without keeping a lease', () => {
    const claimed = claimExecutionStage(createExecutionLifecycle(false), {
      expectedStateVersion: 0,
      leaseExpiresAt,
      leaseOwner: 'worker-1',
      now,
      stage: 'EXTRACT',
    });
    const nextAttemptAt = new Date('2026-07-20T00:05:00.000Z');
    const scheduled = scheduleExecutionStageRetry(claimed, {
      expectedStateVersion: claimed.stateVersion,
      failure: {
        category: 'TRANSIENT',
        code: 'PROVIDER_THROTTLED',
        message: 'The provider is temporarily unavailable.',
        retryable: true,
      },
      leaseOwner: 'worker-1',
      nextAttemptAt,
      now,
      stage: 'EXTRACT',
    });

    expect(scheduled.stages.EXTRACT).toMatchObject({
      nextAttemptAt,
      status: 'RETRY_SCHEDULED',
    });
    expect(scheduled.stages.EXTRACT).not.toHaveProperty('leaseOwner');
    expect(scheduled.stages.EXTRACT).not.toHaveProperty('leaseExpiresAt');
  });

  it('makes terminal failures immutable', () => {
    const claimed = claimExecutionStage(createExecutionLifecycle(false), {
      expectedStateVersion: 0,
      leaseExpiresAt,
      leaseOwner: 'worker-1',
      now,
      stage: 'EXTRACT',
    });
    const failed = failExecution(claimed, {
      expectedStateVersion: claimed.stateVersion,
      failure: {
        category: 'PERMANENT',
        code: 'DOCUMENT_UNSUPPORTED',
        message: 'The document is not supported.',
        retryable: false,
      },
      leaseOwner: 'worker-1',
      stage: 'EXTRACT',
    });

    expect(() =>
      claimExecutionStage(failed, {
        expectedStateVersion: failed.stateVersion,
        leaseExpiresAt,
        leaseOwner: 'worker-2',
        now,
        stage: 'EXTRACT',
      }),
    ).toThrow(new ExecutionTransitionError('EXECUTION_TERMINAL'));
  });
});
