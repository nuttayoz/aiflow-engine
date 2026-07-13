import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { SERVICE_NAME, waitForTerminationSignal } from '@aiflow/core';

import { parseQueueSelection } from './queue-selection';
import { WorkerModule } from './worker.module';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const queues = parseQueueSelection(process.argv.slice(2));

  app.enableShutdownHooks();

  Logger.log(
    `Worker skeleton started; queues=${queues.join(',') || 'none'}`,
    SERVICE_NAME,
  );

  const signal = await waitForTerminationSignal();
  Logger.log(`Worker received ${signal}; shutting down`, SERVICE_NAME);
  await app.close();
};

void bootstrap();
