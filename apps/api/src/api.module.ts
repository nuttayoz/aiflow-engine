import { Module, type DynamicModule } from '@nestjs/common';

import type { DatabaseRuntimeConfig, S3RuntimeConfig } from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';
import { RuntimeTelemetry } from '@aiflow/observability';

import { HealthController } from './health.controller';
import { ApiController } from './api.controller';
import { API_S3_CONFIG, ApiService } from './api.service';

@Module({})
export class ApiModule {
  static register(
    databaseConfig: DatabaseRuntimeConfig,
    s3Config: S3RuntimeConfig,
    telemetry: RuntimeTelemetry,
  ): DynamicModule {
    return {
      controllers: [ApiController, HealthController],
      imports: [
        DatabaseModule.register({ config: databaseConfig, role: 'api' }),
      ],
      module: ApiModule,
      providers: [
        ApiService,
        { provide: API_S3_CONFIG, useValue: s3Config },
        { provide: RuntimeTelemetry, useValue: telemetry },
      ],
    };
  }
}
