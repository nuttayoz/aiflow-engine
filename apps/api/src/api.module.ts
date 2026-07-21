import { Module, type DynamicModule } from '@nestjs/common';

import type { DatabaseRuntimeConfig } from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';
import { RuntimeTelemetry } from '@aiflow/observability';

import { HealthController } from './health.controller';

@Module({})
export class ApiModule {
  static register(
    databaseConfig: DatabaseRuntimeConfig,
    telemetry: RuntimeTelemetry,
  ): DynamicModule {
    return {
      controllers: [HealthController],
      imports: [
        DatabaseModule.register({ config: databaseConfig, role: 'api' }),
      ],
      module: ApiModule,
      providers: [{ provide: RuntimeTelemetry, useValue: telemetry }],
    };
  }
}
