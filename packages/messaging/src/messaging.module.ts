import { Module, type DynamicModule } from '@nestjs/common';

import type { RabbitMqRuntimeConfig } from '@aiflow/config';

import { RabbitMqClient } from './rabbitmq';
import type { QueueBinding } from './topology';

export const RABBIT_MQ_CLIENT = Symbol('RABBIT_MQ_CLIENT');

export interface MessagingModuleOptions {
  readonly bindings?: readonly QueueBinding[];
  readonly config: RabbitMqRuntimeConfig;
}

@Module({})
export class MessagingModule {
  static register(options: MessagingModuleOptions): DynamicModule {
    const client = new RabbitMqClient(options.config, options.bindings);

    return {
      exports: [RABBIT_MQ_CLIENT],
      module: MessagingModule,
      providers: [{ provide: RABBIT_MQ_CLIENT, useValue: client }],
    };
  }
}
