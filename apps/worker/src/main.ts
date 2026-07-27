import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  loadDatabaseRuntimeConfig,
  loadObservabilityRuntimeConfig,
  loadRabbitMqRuntimeConfig,
  loadRuntimeConfig,
  loadS3RuntimeConfig,
  loadSharePointRuntimeConfig,
} from '@aiflow/config';
import { waitForTerminationSignal } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  RuntimeTelemetry,
  toSafeErrorLog,
} from '@aiflow/observability';

import { parseQueueSelection, resolveQueueNames } from './queue-selection';
import { WorkerModule } from './worker.module';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'worker',
});
let telemetry: RuntimeTelemetry | undefined;

const bootstrap = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('worker');
  const databaseConfig = loadDatabaseRuntimeConfig();
  const rabbitMqConfig = loadRabbitMqRuntimeConfig();
  const s3Config = loadS3RuntimeConfig();
  const sharePointConfig = loadSharePointRuntimeConfig();
  telemetry = new RuntimeTelemetry(
    loadObservabilityRuntimeConfig('worker'),
    runtimeConfig.environment,
    runtimeConfig.role,
  );
  const queues = resolveQueueNames(parseQueueSelection(process.argv.slice(2)));

  logger = createStructuredLogger({
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const app = await NestFactory.createApplicationContext(
    WorkerModule.register({
      database: databaseConfig,
      queueNames: queues,
      rabbitMq: rabbitMqConfig,
      s3: s3Config,
      sharePoint: sharePointConfig,
      syntheticStagesEnabled: runtimeConfig.environment !== 'production',
      telemetry,
    }),
    {
      logger: new NestStructuredLogger(logger),
    },
  );

  logger.info({ event: 'runtime.started', queues }, 'Worker started');

  const signal = await waitForTerminationSignal();
  logger.info({ event: 'runtime.stopping', signal }, 'Worker stopping');
  await app.close();
};

void bootstrap().catch(async (error: unknown) => {
  telemetry?.captureException(error, 'runtime.startup');
  logger.fatal(
    { event: 'runtime.startup.failed', ...toSafeErrorLog(error) },
    'Worker failed to start',
  );
  await telemetry?.close();
  process.exitCode = 1;
});
