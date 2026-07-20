import { Module, type DynamicModule } from '@nestjs/common';

import type { DatabaseRuntimeConfig } from '@aiflow/config';
import type { RuntimeRole } from '@aiflow/core';

import { createApplicationDataSource } from './data-source';
import { DATABASE_DATA_SOURCE, DatabaseService } from './database.service';

export interface DatabaseModuleOptions {
  config: DatabaseRuntimeConfig;
  role: RuntimeRole;
}

@Module({})
export class DatabaseModule {
  static register(options: DatabaseModuleOptions): DynamicModule {
    return {
      exports: [DATABASE_DATA_SOURCE, DatabaseService],
      module: DatabaseModule,
      providers: [
        {
          provide: DATABASE_DATA_SOURCE,
          useValue: createApplicationDataSource(options.config, options.role),
        },
        DatabaseService,
      ],
    };
  }
}
