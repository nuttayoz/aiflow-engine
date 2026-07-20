import { Module, type DynamicModule } from '@nestjs/common';

import type { DatabaseRuntimeConfig } from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';

import { HealthController } from './health.controller';

@Module({})
export class ApiModule {
  static register(databaseConfig: DatabaseRuntimeConfig): DynamicModule {
    return {
      controllers: [HealthController],
      imports: [
        DatabaseModule.register({ config: databaseConfig, role: 'api' }),
      ],
      module: ApiModule,
    };
  }
}
