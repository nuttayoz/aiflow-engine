import { once } from 'node:events';

import {
  connect,
  type Channel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Message,
  type RecoveringChannelModel,
} from 'amqplib';

import type { RabbitMqRuntimeConfig } from '@aiflow/config';

import {
  encodeMessageEnvelope,
  routingKeyForMessageType,
  validateMessageEnvelope,
  type MessageEnvelope,
} from './envelope';
import type {
  MessageConsumer,
  MessageHandler,
  MessagePublisher,
  PublishResult,
} from './ports';
import {
  COMMAND_EXCHANGE,
  CORE_QUEUE_BINDINGS,
  DEAD_LETTER_EXCHANGE,
  deadLetterQueueName,
  type QueueBinding,
} from './topology';

export class RabbitMqError extends Error {
  constructor(
    readonly code:
      'BROKER_NOT_READY' | 'BROKER_PUBLISH_FAILED' | 'BROKER_UNROUTABLE',
  ) {
    super(code);
    this.name = 'RabbitMqError';
  }
}

export class RabbitMqClient implements MessageConsumer, MessagePublisher {
  private connection?: RecoveringChannelModel;
  private publisher?: ConfirmChannel;
  private readonly returnedMessageIds = new Set<string>();
  private stopping = false;

  constructor(
    private readonly config: RabbitMqRuntimeConfig,
    private readonly bindings: readonly QueueBinding[] = CORE_QUEUE_BINDINGS,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  async initialize(): Promise<void> {
    if (this.connection !== undefined) {
      return;
    }
    this.stopping = false;
    const connection = await connect(this.config.url, {
      recovery: {
        factor: 2,
        initialDelay: 250,
        jitter: 0.2,
        maxDelay: 5_000,
      },
      timeout: this.config.connectionTimeoutMs,
    });
    this.connection = connection;
    this.publisher = await connection.createConfirmChannel();
    this.publisher.on('return', (message) => this.recordReturn(message));
    await this.assertTopology(this.publisher);
  }

  isReady(): boolean {
    return this.connection !== undefined && this.publisher !== undefined;
  }

  async publish(envelope: MessageEnvelope): Promise<PublishResult> {
    const publisher = this.publisher;
    if (publisher === undefined || this.stopping) {
      throw new RabbitMqError('BROKER_NOT_READY');
    }

    const content = encodeMessageEnvelope(envelope);
    let writable = true;
    const confirmed = new Promise<void>((resolve, reject) => {
      writable = publisher.publish(
        COMMAND_EXCHANGE,
        routingKeyForMessageType(envelope.type),
        content,
        {
          contentType: 'application/json',
          correlationId: envelope.correlationId,
          deliveryMode: 2,
          mandatory: true,
          messageId: envelope.messageId,
          timestamp: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
          type: envelope.type,
        },
        (error: unknown) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(new RabbitMqError('BROKER_PUBLISH_FAILED'));
          }
        },
      );
    });

    if (!writable) {
      await once(publisher, 'drain');
    }
    await confirmed;
    if (this.returnedMessageIds.delete(envelope.messageId)) {
      throw new RabbitMqError('BROKER_UNROUTABLE');
    }

    return { confirmedAt: new Date() };
  }

  async start(queueName: string, handler: MessageHandler): Promise<void> {
    const connection = this.connection;
    if (connection === undefined || this.stopping) {
      throw new RabbitMqError('BROKER_NOT_READY');
    }
    if (!this.bindings.some((binding) => binding.name === queueName)) {
      throw new Error('BROKER_QUEUE_NOT_DECLARED');
    }

    const channel = await connection.createChannel();
    await channel.prefetch(this.config.prefetch);
    await channel.consume(
      queueName,
      (message) => {
        if (message !== null) {
          void this.handleDelivery(channel, message, handler);
        }
      },
      { noAck: false },
    );
  }

  async replayDeadLetters(
    sourceQueueName: string,
    limit: number,
  ): Promise<{ failed: number; replayed: number }> {
    if (
      !/^aiflow\.q\.[a-z0-9.-]+\.v[1-9][0-9]*$/u.test(sourceQueueName) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new Error('DLQ_REPLAY_INPUT_INVALID');
    }
    const connection = this.connection;
    if (connection === undefined || this.stopping) {
      throw new RabbitMqError('BROKER_NOT_READY');
    }

    const channel = await connection.createChannel();
    let failed = 0;
    let replayed = 0;
    try {
      for (let index = 0; index < limit; index += 1) {
        const message = await channel.get(
          deadLetterQueueName(sourceQueueName),
          {
            noAck: false,
          },
        );
        if (message === false) {
          break;
        }
        const validation = validateMessageEnvelope(message.content);
        if (!validation.valid) {
          channel.nack(message, false, true);
          failed += 1;
          break;
        }
        try {
          await this.publish(validation.envelope);
          channel.ack(message);
          replayed += 1;
        } catch {
          channel.nack(message, false, true);
          failed += 1;
          break;
        }
      }
      return { failed, replayed };
    } finally {
      await channel.close();
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    const connection = this.connection;
    this.connection = undefined;
    this.publisher = undefined;
    if (connection !== undefined) {
      await connection.close();
    }
  }

  private async assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(COMMAND_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', {
      durable: true,
    });

    for (const binding of this.bindings) {
      const deadLetterQueue = deadLetterQueueName(binding.name);
      await channel.assertQueue(deadLetterQueue, {
        arguments: { 'x-queue-type': 'quorum' },
        durable: true,
      });
      await channel.bindQueue(
        deadLetterQueue,
        DEAD_LETTER_EXCHANGE,
        binding.name,
      );
      await channel.assertQueue(binding.name, {
        arguments: {
          'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
          'x-dead-letter-routing-key': binding.name,
          'x-delivery-limit': 20,
          'x-queue-type': 'quorum',
        },
        durable: true,
      });
      for (const key of binding.bindingKeys) {
        await channel.bindQueue(binding.name, COMMAND_EXCHANGE, key);
      }
    }
  }

  private async handleDelivery(
    channel: Channel,
    message: ConsumeMessage,
    handler: MessageHandler,
  ): Promise<void> {
    const validation = validateMessageEnvelope(message.content);
    if (
      !validation.valid ||
      !handler.messageTypes.includes(validation.envelope.type)
    ) {
      channel.reject(message, false);
      return;
    }

    try {
      await handler.handle(validation.envelope);
      channel.ack(message);
    } catch {
      if (!this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        channel.nack(message, false, true);
      }
    }
  }

  private recordReturn(message: Message): void {
    if (typeof message.properties.messageId === 'string') {
      this.returnedMessageIds.add(message.properties.messageId);
    }
  }
}
