import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { loadApiRuntimeConfig } from '@aiflow/config';
import { SERVICE_NAME } from '@aiflow/core';

import { ApiModule } from './api.module';

const bootstrap = async (): Promise<void> => {
  const config = loadApiRuntimeConfig();
  const app = await NestFactory.create(ApiModule);

  app.enableShutdownHooks();
  await app.listen(config.port, config.host);

  Logger.log(`API listening on ${config.host}:${config.port}`, SERVICE_NAME);
};

void bootstrap();
