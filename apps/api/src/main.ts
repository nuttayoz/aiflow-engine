import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  loadApiRuntimeConfig,
  loadDatabaseRuntimeConfig,
  loadObservabilityRuntimeConfig,
  loadRuntimeConfig,
  loadS3RuntimeConfig,
  loadSharePointRuntimeConfig,
} from '@aiflow/config';
import { RequestContextStore } from '@aiflow/core';
import {
  createStructuredLogger,
  NestStructuredLogger,
  RuntimeTelemetry,
  toSafeErrorLog,
} from '@aiflow/observability';

import { ApiModule } from './api.module';
import { createDemoAuthMiddleware } from './api-auth';
import { ApiErrorFilter } from './api-error.filter';
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
  const s3Config = loadS3RuntimeConfig();
  const sharePointConfig = loadSharePointRuntimeConfig();
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
    ApiModule.register(
      databaseConfig,
      s3Config,
      sharePointConfig,
      runtimeConfig.environment !== 'production',
      telemetry,
    ),
    { logger: new NestStructuredLogger(logger), rawBody: true },
  );

  if (runtimeConfig.environment !== 'production') {
    app.enableCors({
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'Idempotency-Key',
        'X-Correlation-ID',
      ],
      methods: ['DELETE', 'GET', 'OPTIONS', 'POST', 'PUT'],
      origin: 'http://localhost:4173',
    });
  }
  app.use(createRequestContextMiddleware(contextStore, logger));
  app.use(createDemoAuthMiddleware(runtimeConfig.environment));
  app.useGlobalFilters(new ApiErrorFilter());
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
