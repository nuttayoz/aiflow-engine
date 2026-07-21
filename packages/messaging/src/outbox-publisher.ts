import type { MessagePublisher, OutboxRepository } from './ports';
import { RabbitMqError } from './rabbitmq';

export interface OutboxPublishBatchResult {
  readonly claimed: number;
  readonly failed: number;
  readonly published: number;
}

export class OutboxPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly messages: MessagePublisher,
  ) {}

  async publishBatch(input: {
    readonly batchSize: number;
    readonly leaseDurationMs: number;
    readonly owner: string;
  }): Promise<OutboxPublishBatchResult> {
    const claimed = await this.outbox.claim(input);
    let failed = 0;
    let published = 0;

    for (const record of claimed) {
      try {
        await this.messages.publish(record.envelope);
        if (await this.outbox.markPublished(record.id, input.owner)) {
          published += 1;
        } else {
          failed += 1;
        }
      } catch (error: unknown) {
        failed += 1;
        const code =
          error instanceof RabbitMqError ? error.code : 'BROKER_PUBLISH_FAILED';
        await this.outbox.release(record.id, input.owner, code);
      }
    }

    return { claimed: claimed.length, failed, published };
  }
}
