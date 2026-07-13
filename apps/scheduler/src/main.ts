import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { SERVICE_NAME, waitForTerminationSignal } from '@aiflow/core';

import { SchedulerModule } from './scheduler.module';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(SchedulerModule);

  app.enableShutdownHooks();
  Logger.log('Scheduler skeleton started; no jobs registered', SERVICE_NAME);

  const signal = await waitForTerminationSignal();
  Logger.log(`Scheduler received ${signal}; shutting down`, SERVICE_NAME);
  await app.close();
};

void bootstrap();
