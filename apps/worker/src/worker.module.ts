import { Module, type DynamicModule } from '@nestjs/common';

import type {
  DatabaseRuntimeConfig,
  RabbitMqRuntimeConfig,
  S3RuntimeConfig,
  SharePointRuntimeConfig,
} from '@aiflow/config';
import { DatabaseModule } from '@aiflow/database';
import {
  connectorQueueBinding,
  CORE_QUEUE_BINDINGS,
  MessagingModule,
} from '@aiflow/messaging';
import { RuntimeTelemetry } from '@aiflow/observability';

import { FoundationWorkerService } from './foundation-worker.service';
import {
  SYNTHETIC_STAGES_ENABLED,
  WORKER_QUEUE_NAMES,
  WORKER_S3_CONFIG,
  WORKER_SHAREPOINT_CONFIG,
} from './worker.tokens';

export interface WorkerModuleOptions {
  database: DatabaseRuntimeConfig;
  queueNames: readonly string[];
  rabbitMq: RabbitMqRuntimeConfig;
  s3: S3RuntimeConfig;
  sharePoint: SharePointRuntimeConfig;
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
            connectorQueueBinding('microsoft-business-central', 'deliver'),
            connectorQueueBinding('microsoft-sharepoint', 'sync'),
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
        { provide: WORKER_S3_CONFIG, useValue: options.s3 },
        { provide: WORKER_SHAREPOINT_CONFIG, useValue: options.sharePoint },
        {
          provide: SYNTHETIC_STAGES_ENABLED,
          useValue: options.syntheticStagesEnabled,
        },
      ],
    };
  }
}
