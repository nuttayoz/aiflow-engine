import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';

import { SERVICE_NAME } from '@aiflow/core';
import { DatabaseService } from '@aiflow/database';

export interface LivenessResponse {
  role: 'api';
  service: typeof SERVICE_NAME;
  status: 'ok';
}

export interface ReadinessResponse extends LivenessResponse {
  dependencies: {
    database: 'ready';
  };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get('live')
  live(): LivenessResponse {
    return {
      role: 'api',
      service: SERVICE_NAME,
      status: 'ok',
    };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const database = await this.database.checkReadiness();

    if (database.status !== 'ready') {
      throw new ServiceUnavailableException({
        dependencies: { database: database.status },
        error: { code: database.code },
        role: 'api',
        service: SERVICE_NAME,
        status: 'unavailable',
      });
    }

    return {
      dependencies: { database: 'ready' },
      ...this.live(),
    };
  }
}
