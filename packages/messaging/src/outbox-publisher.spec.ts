import type {
  MessagePublisher,
  OutboxMessageRecord,
  OutboxRepository,
} from './ports';
import { OutboxPublisher } from './outbox-publisher';

const record = {
  aggregateId: 'execution-1',
  aggregateType: 'EXECUTION',
  availableAt: new Date(),
  envelope: {
    actor: { id: 'system', type: 'SYSTEM' },
    causationId: 'cause-1',
    correlationId: 'correlation-1',
    data: {
      executionId: 'execution-1',
      expectedStateVersion: 0,
      stage: 'EXTRACT',
    },
    kind: 'COMMAND',
    messageId: 'message-1',
    occurredAt: new Date().toISOString(),
    projectId: 'project-1',
    schemaVersion: 1,
    tenantId: 'tenant-1',
    type: 'aiflow.execution.stage.extract.requested.v1',
  },
  id: 'outbox-1',
  messageId: 'message-1',
  publishAttemptCount: 1,
  publishLeaseOwner: 'publisher-1',
} satisfies OutboxMessageRecord;

describe('OutboxPublisher', () => {
  it('marks only confirmed messages as published', async () => {
    const outbox = {
      claim: jest.fn().mockResolvedValue([record]),
      markPublished: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    } satisfies jest.Mocked<OutboxRepository>;
    const messages = {
      publish: jest.fn().mockResolvedValue({ confirmedAt: new Date() }),
    } satisfies jest.Mocked<MessagePublisher>;

    await expect(
      new OutboxPublisher(outbox, messages).publishBatch({
        batchSize: 10,
        leaseDurationMs: 10_000,
        owner: 'publisher-1',
      }),
    ).resolves.toEqual({ claimed: 1, failed: 0, published: 1 });
    expect(outbox.markPublished).toHaveBeenCalledWith(
      'outbox-1',
      'publisher-1',
    );
  });

  it('releases an uncertain publication for retry with the same message', async () => {
    const outbox = {
      claim: jest.fn().mockResolvedValue([record]),
      markPublished: jest.fn().mockResolvedValue(false),
      release: jest.fn().mockResolvedValue(true),
    } satisfies jest.Mocked<OutboxRepository>;
    const messages = {
      publish: jest.fn().mockRejectedValue(new Error('connection lost')),
    } satisfies jest.Mocked<MessagePublisher>;

    await expect(
      new OutboxPublisher(outbox, messages).publishBatch({
        batchSize: 10,
        leaseDurationMs: 10_000,
        owner: 'publisher-1',
      }),
    ).resolves.toEqual({ claimed: 1, failed: 1, published: 0 });
    expect(outbox.release).toHaveBeenCalledWith(
      'outbox-1',
      'publisher-1',
      'BROKER_PUBLISH_FAILED',
    );
    expect(record.envelope.messageId).toBe('message-1');
  });
});
