import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  loadDatabaseRuntimeConfig,
  loadObservabilityRuntimeConfig,
  loadRabbitMqRuntimeConfig,
  loadRuntimeConfig,
} from '@aiflow/config';
import { waitForTerminationSignal } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  RuntimeTelemetry,
  toSafeErrorLog,
} from '@aiflow/observability';

import { SchedulerModule } from './scheduler.module';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'scheduler',
});
let telemetry: RuntimeTelemetry | undefined;

const bootstrap = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('scheduler');
  const databaseConfig = loadDatabaseRuntimeConfig();
  const rabbitMqConfig = loadRabbitMqRuntimeConfig();
  telemetry = new RuntimeTelemetry(
    loadObservabilityRuntimeConfig('scheduler'),
    runtimeConfig.environment,
    runtimeConfig.role,
  );

  logger = createStructuredLogger({
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const app = await NestFactory.createApplicationContext(
    SchedulerModule.register({
      database: databaseConfig,
      rabbitMq: rabbitMqConfig,
      telemetry,
    }),
    {
      logger: new NestStructuredLogger(logger),
    },
  );

  logger.info({ event: 'runtime.started' }, 'Scheduler started');

  const signal = await waitForTerminationSignal();
  logger.info({ event: 'runtime.stopping', signal }, 'Scheduler stopping');
  await app.close();
};

void bootstrap().catch(async (error: unknown) => {
  telemetry?.captureException(error, 'runtime.startup');
  logger.fatal(
    { event: 'runtime.startup.failed', ...toSafeErrorLog(error) },
    'Scheduler failed to start',
  );
  await telemetry?.close();
  process.exitCode = 1;
});
