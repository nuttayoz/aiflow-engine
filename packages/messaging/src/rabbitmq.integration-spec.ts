import {
  RabbitMQContainer,
  type StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { connect, type ChannelModel } from 'amqplib';

import { createMessageEnvelope } from './envelope';
import { RabbitMqClient, RabbitMqError } from './rabbitmq';
import {
  COMMAND_EXCHANGE,
  CORE_QUEUE_BINDINGS,
  connectorQueueBinding,
  DEAD_LETTER_EXCHANGE,
  deadLetterQueueName,
} from './topology';

describe('RabbitMQ foundation', () => {
  let container: StartedRabbitMQContainer;
  let client: RabbitMqClient;
  let rawConnection: ChannelModel;

  beforeAll(async () => {
    container = await new RabbitMQContainer(
      'rabbitmq:4.3.2-management',
    ).start();
    client = new RabbitMqClient(
      {
        connectionTimeoutMs: 10_000,
        prefetch: 2,
        url: container.getAmqpUrl(),
      },
      [...CORE_QUEUE_BINDINGS, connectorQueueBinding('synthetic', 'deliver')],
    );
    await client.initialize();
    rawConnection = await connect(container.getAmqpUrl());
  });

  afterAll(async () => {
    await rawConnection?.close();
    await client?.close();
    await container?.stop();
  });

  it('confirms persistent commands and safely redelivers handler failures', async () => {
    let deliveries = 0;
    let complete: (() => void) | undefined;
    const handled = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await client.start('aiflow.q.stage.extract.v1', {
      handle: async () => {
        deliveries += 1;
        if (deliveries === 1) {
          throw new Error('simulated database interruption');
        }
        complete?.();
        return 'CLAIMED';
      },
      messageTypes: ['aiflow.execution.stage.extract.requested.v1'],
    });
    const envelope = createMessageEnvelope({
      actor: { id: 'system', type: 'SYSTEM' },
      causationId: 'test-run',
      correlationId: 'correlation-1',
      data: {
        executionId: 'execution-1',
        expectedStateVersion: 0,
        stage: 'EXTRACT',
      },
      projectId: 'project-1',
      tenantId: 'tenant-1',
      type: 'aiflow.execution.stage.extract.requested.v1',
    });

    await expect(client.publish(envelope)).resolves.toMatchObject({
      confirmedAt: expect.any(Date),
    });
    await handled;
    expect(deliveries).toBe(2);
  });

  it('rejects malformed deliveries into the inspectable queue DLQ', async () => {
    const channel = await rawConnection.createConfirmChannel();
    channel.publish(
      COMMAND_EXCHANGE,
      'execution.stage.extract.requested.v1',
      Buffer.from('{not-json'),
      { deliveryMode: 2 },
    );

    const deadline = Date.now() + 5_000;
    let deadLetter = false;
    while (!deadLetter && Date.now() < deadline) {
      const message = await channel.get(
        deadLetterQueueName('aiflow.q.stage.extract.v1'),
        { noAck: false },
      );
      deadLetter = message !== false;
      if (message !== false) {
        channel.nack(message, false, true);
      }
      if (!deadLetter) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    expect(deadLetter).toBe(true);
    await channel.close();
  });

  it('safely replays valid dead letters with the original message identity', async () => {
    const envelope = createMessageEnvelope({
      actor: { id: 'system', type: 'SYSTEM' },
      causationId: 'test-run',
      correlationId: 'correlation-replay',
      data: {
        executionId: 'execution-replay',
        expectedStateVersion: 1,
        stage: 'MAP',
      },
      projectId: 'project-1',
      tenantId: 'tenant-1',
      type: 'aiflow.execution.stage.map.requested.v1',
    });
    const channel = await rawConnection.createConfirmChannel();
    channel.publish(
      DEAD_LETTER_EXCHANGE,
      'aiflow.q.stage.map.v1',
      Buffer.from(JSON.stringify(envelope)),
      { deliveryMode: 2, messageId: envelope.messageId },
    );
    await channel.waitForConfirms();
    const handled = new Promise<string>((resolve) => {
      void client.start('aiflow.q.stage.map.v1', {
        handle: async (message) => {
          resolve(message.messageId);
          return 'CLAIMED';
        },
        messageTypes: ['aiflow.execution.stage.map.requested.v1'],
      });
    });

    await expect(
      client.replayDeadLetters('aiflow.q.stage.map.v1', 10),
    ).resolves.toEqual({ failed: 0, replayed: 1 });
    await expect(handled).resolves.toBe(envelope.messageId);
    await channel.close();
  });

  it('fails mandatory publication when no connector queue is bound', async () => {
    const envelope = createMessageEnvelope({
      actor: { id: 'system', type: 'SYSTEM' },
      causationId: 'test-run',
      correlationId: 'correlation-2',
      data: {
        connectorId: 'missing',
        executionId: 'execution-2',
        expectedStateVersion: 0,
        stage: 'DELIVER',
      },
      projectId: 'project-1',
      tenantId: 'tenant-1',
      type: 'aiflow.execution.stage.deliver.connector.missing.requested.v1',
    });

    await expect(client.publish(envelope)).rejects.toEqual(
      new RabbitMqError('BROKER_UNROUTABLE'),
    );
  });
});
