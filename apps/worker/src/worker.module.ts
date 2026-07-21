import { Module, type DynamicModule } from '@nestjs/common';

import type {
  DatabaseRuntimeConfig,
  RabbitMqRuntimeConfig,
} from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';
import {
  connectorQueueBinding,
  CORE_QUEUE_BINDINGS,
  MessagingModule,
} from '@aiflow/messaging';
import { RuntimeTelemetry } from '@aiflow/observability';

import { FoundationWorkerService } from './foundation-worker.service';
import { SYNTHETIC_STAGES_ENABLED, WORKER_QUEUE_NAMES } from './worker.tokens';

export interface WorkerModuleOptions {
  database: DatabaseRuntimeConfig;
  queueNames: readonly string[];
  rabbitMq: RabbitMqRuntimeConfig;
  syntheticStagesEnabled: boolean;
  telemetry: RuntimeTelemetry;
}

@Module({})
export class WorkerModule {
  static register(options: WorkerModuleOptions): DynamicModule {
    return {
      imports: [
        DatabaseModule.register({ config: options.database, role: 'worker' }),
        MessagingModule.register({
          bindings: [
            ...CORE_QUEUE_BINDINGS,
            connectorQueueBinding('phase1-synthetic', 'deliver'),
          ],
          config: options.rabbitMq,
        }),
      ],
      module: WorkerModule,
      providers: [
        FoundationWorkerService,
        { provide: RuntimeTelemetry, useValue: options.telemetry },
        { provide: WORKER_QUEUE_NAMES, useValue: options.queueNames },
        {
          provide: SYNTHETIC_STAGES_ENABLED,
          useValue: options.syntheticStagesEnabled,
        },
      ],
    };
  }
}
