import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadRuntimeConfig } from '@aiflow/config';
import { waitForTerminationSignal } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  toSafeErrorLog,
} from '@aiflow/observability';

import { SchedulerModule } from './scheduler.module';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'scheduler',
});

const bootstrap = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('scheduler');

  logger = createStructuredLogger({
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const app = await NestFactory.createApplicationContext(SchedulerModule, {
    logger: new NestStructuredLogger(logger),
  });

  app.enableShutdownHooks();
  logger.info(
    { event: 'runtime.started' },
    'Scheduler skeleton started; no jobs registered',
  );

  const signal = await waitForTerminationSignal();
  logger.info({ event: 'runtime.stopping', signal }, 'Scheduler stopping');
  await app.close();
};

void bootstrap().catch((error: unknown) => {
  logger.fatal(
    { event: 'runtime.startup.failed', ...toSafeErrorLog(error) },
    'Scheduler failed to start',
  );
  process.exitCode = 1;
});
