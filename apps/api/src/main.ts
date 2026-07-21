import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  loadApiRuntimeConfig,
  loadDatabaseRuntimeConfig,
  loadObservabilityRuntimeConfig,
  loadRuntimeConfig,
} from '@aiflow/config';
import { RequestContextStore } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  RuntimeTelemetry,
  toSafeErrorLog,
} from '@aiflow/observability';

import { ApiModule } from './api.module';
import { createRequestContextMiddleware } from './request-context.middleware';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'api',
});
let telemetry: RuntimeTelemetry | undefined;

const bootstrap = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('api');
  const apiConfig = loadApiRuntimeConfig();
  const databaseConfig = loadDatabaseRuntimeConfig();
  telemetry = new RuntimeTelemetry(
    loadObservabilityRuntimeConfig('api'),
    runtimeConfig.environment,
    runtimeConfig.role,
  );
  const contextStore = new RequestContextStore();

  logger = createStructuredLogger({
    contextStore,
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const app = await NestFactory.create(
    ApiModule.register(databaseConfig, telemetry),
    { logger: new NestStructuredLogger(logger) },
  );

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

void bootstrap().catch(async (error: unknown) => {
  telemetry?.captureException(error, 'runtime.startup');
  logger.fatal(
    { event: 'runtime.startup.failed', ...toSafeErrorLog(error) },
    'API failed to start',
  );
  await telemetry?.close();
  process.exitCode = 1;
});
