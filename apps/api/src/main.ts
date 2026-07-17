import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadApiRuntimeConfig, loadRuntimeConfig } from '@aiflow/config';
import { RequestContextStore } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  toSafeErrorLog,
} from '@aiflow/observability';

import { ApiModule } from './api.module';
import { createRequestContextMiddleware } from './request-context.middleware';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'api',
});

const bootstrap = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('api');
  const apiConfig = loadApiRuntimeConfig();
  const contextStore = new RequestContextStore();

  logger = createStructuredLogger({
    contextStore,
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const app = await NestFactory.create(ApiModule, {
    logger: new NestStructuredLogger(logger),
  });

  app.use(createRequestContextMiddleware(contextStore, logger));
  app.enableShutdownHooks();
  await app.listen(apiConfig.port, apiConfig.host);

  logger.info(
    {
      event: 'runtime.started',
      host: apiConfig.host,
      port: apiConfig.port,
    },
    'API started',
  );
};

void bootstrap().catch((error: unknown) => {
  logger.fatal(
    { event: 'runtime.startup.failed', ...toSafeErrorLog(error) },
    'API failed to start',
  );
  process.exitCode = 1;
});
