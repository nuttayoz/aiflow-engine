import { Module, type DynamicModule } from '@nestjs/common';

import type { DatabaseRuntimeConfig } from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';

@Module({})
export class WorkerModule {
  static register(databaseConfig: DatabaseRuntimeConfig): DynamicModule {
    return {
      imports: [
        DatabaseModule.register({ config: databaseConfig, role: 'worker' }),
      ],
      module: WorkerModule,
    };
  }
}
