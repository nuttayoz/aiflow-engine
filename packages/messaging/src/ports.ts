import type { MessageEnvelope, MessageType } from './envelope';

export interface OutboxMessageRecord {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly availableAt: Date;
  readonly envelope: MessageEnvelope;
  readonly id: string;
  readonly messageId: string;
  readonly publishAttemptCount: number;
  readonly publishLeaseOwner?: string;
}

export interface OutboxClaimOptions {
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly owner: string;
}

export interface OutboxRepository {
  claim(options: OutboxClaimOptions): Promise<readonly OutboxMessageRecord[]>;
  markPublished(id: string, owner: string): Promise<boolean>;
  release(id: string, owner: string, safeErrorCode: string): Promise<boolean>;
}

export interface PublishResult {
  readonly confirmedAt: Date;
}

export interface MessagePublisher {
  publish(envelope: MessageEnvelope): Promise<PublishResult>;
}

export type MessageHandlingOutcome = 'CLAIMED' | 'DUPLICATE' | 'STALE';

export interface MessageHandler {
  readonly messageTypes: readonly MessageType[];
  handle(envelope: MessageEnvelope): Promise<MessageHandlingOutcome>;
}

export interface MessageConsumer {
  close(): Promise<void>;
  start(queueName: string, handler: MessageHandler): Promise<void>;
}
