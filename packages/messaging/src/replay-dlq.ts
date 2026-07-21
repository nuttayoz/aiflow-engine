import { loadRabbitMqRuntimeConfig, loadRuntimeConfig } from '@aiflow/config';
import { createStructuredLogger, toSafeErrorLog } from '@aiflow/observability';

import { RabbitMqClient } from './rabbitmq';

const arguments_ = process.argv.slice(2);
const queue = arguments_
  .find((argument) => argument.startsWith('--queue='))
  ?.slice('--queue='.length);
const limitValue = arguments_
  .find((argument) => argument.startsWith('--limit='))
  ?.slice('--limit='.length);
const limit = limitValue === undefined ? 100 : Number(limitValue);
const runtime = loadRuntimeConfig('scheduler');
const logger = createStructuredLogger({
  environment: runtime.environment,
  level: runtime.logLevel,
  role: runtime.role,
});

const replay = async (): Promise<void> => {
  if (queue === undefined) {
    throw new Error('DLQ_REPLAY_QUEUE_REQUIRED');
  }
  const client = new RabbitMqClient(loadRabbitMqRuntimeConfig());
  try {
    await client.initialize();
    const result = await client.replayDeadLetters(queue, limit);
    logger.info(
      { event: 'broker.dlq.replay.completed', queue, ...result },
      'DLQ replay completed',
    );
    if (result.failed > 0) {
      process.exitCode = 2;
    }
  } finally {
    await client.close();
  }
};

void replay().catch((error: unknown) => {
  logger.fatal(
    { event: 'broker.dlq.replay.failed', ...toSafeErrorLog(error) },
    'DLQ replay failed',
  );
  process.exitCode = 1;
});
