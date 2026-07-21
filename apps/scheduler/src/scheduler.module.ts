import { Module, type DynamicModule } from '@nestjs/common';

import type {
  DatabaseRuntimeConfig,
  RabbitMqRuntimeConfig,
  S3RuntimeConfig,
} from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';
import { MessagingModule } from '@aiflow/messaging';
import { RuntimeTelemetry } from '@aiflow/observability';

import { FoundationSchedulerService } from './foundation-scheduler.service';
import { SCHEDULER_S3_CONFIG } from './scheduler.tokens';

export interface SchedulerModuleOptions {
  database: DatabaseRuntimeConfig;
  rabbitMq: RabbitMqRuntimeConfig;
  s3: S3RuntimeConfig;
  telemetry: RuntimeTelemetry;
}

@Module({})
export class SchedulerModule {
  static register(options: SchedulerModuleOptions): DynamicModule {
    return {
      imports: [
        DatabaseModule.register({
          config: options.database,
          role: 'scheduler',
        }),
        MessagingModule.register({ config: options.rabbitMq }),
      ],
      module: SchedulerModule,
      providers: [
        FoundationSchedulerService,
        { provide: RuntimeTelemetry, useValue: options.telemetry },
        { provide: SCHEDULER_S3_CONFIG, useValue: options.s3 },
      ],
    };
  }
}
