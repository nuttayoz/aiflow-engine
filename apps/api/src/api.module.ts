import { Module, type DynamicModule } from '@nestjs/common';

import type {
  DatabaseRuntimeConfig,
  S3RuntimeConfig,
  SharePointRuntimeConfig,
} from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';
import { RuntimeTelemetry } from '@aiflow/observability';

import { HealthController } from './health.controller';
import { ApiController } from './api.controller';
import {
  API_S3_CONFIG,
  API_SHAREPOINT_CONFIG,
  API_SYNTHETIC_PROVIDERS_ENABLED,
  ApiService,
} from './api.service';
import {
  SharePointCallbackController,
  SharePointCallbackService,
} from './sharepoint-callback.controller';

@Module({})
export class ApiModule {
  static register(
    databaseConfig: DatabaseRuntimeConfig,
    s3Config: S3RuntimeConfig,
    sharePointConfig: SharePointRuntimeConfig,
    syntheticProvidersEnabled: boolean,
    telemetry: RuntimeTelemetry,
  ): DynamicModule {
    return {
      controllers: [
        ApiController,
        HealthController,
        SharePointCallbackController,
      ],
      imports: [
        DatabaseModule.register({ config: databaseConfig, role: 'api' }),
      ],
      module: ApiModule,
      providers: [
        ApiService,
        SharePointCallbackService,
        { provide: API_S3_CONFIG, useValue: s3Config },
        { provide: API_SHAREPOINT_CONFIG, useValue: sharePointConfig },
        {
          provide: API_SYNTHETIC_PROVIDERS_ENABLED,
          useValue: syntheticProvidersEnabled,
        },
        { provide: RuntimeTelemetry, useValue: telemetry },
      ],
    };
  }
}
