import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadDatabaseRuntimeConfig, loadRuntimeConfig } from '@aiflow/config';
import { waitForTerminationSignal } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  toSafeErrorLog,
} from '@aiflow/observability';

import { parseQueueSelection } from './queue-selection';
import { WorkerModule } from './worker.module';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'worker',
});

const bootstrap = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('worker');
  const databaseConfig = loadDatabaseRuntimeConfig();
  const queues = parseQueueSelection(process.argv.slice(2));

  logger = createStructuredLogger({
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(databaseConfig),
    {
      logger: new NestStructuredLogger(logger),
    },
  );

  app.enableShutdownHooks();
  logger.info({ event: 'runtime.started', queues }, 'Worker skeleton started');

  const signal = await waitForTerminationSignal();
  logger.info({ event: 'runtime.stopping', signal }, 'Worker stopping');
  await app.close();
};

void bootstrap().catch((error: unknown) => {
  logger.fatal(
    { event: 'runtime.startup.failed', ...toSafeErrorLog(error) },
    'Worker failed to start',
  );
  process.exitCode = 1;
});
