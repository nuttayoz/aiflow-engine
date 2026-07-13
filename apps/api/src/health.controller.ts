import { Controller, Get } from '@nestjs/common';

import { SERVICE_NAME } from '@aiflow/core';

export interface HealthResponse {
  role: 'api';
  service: typeof SERVICE_NAME;
  status: 'ok';
}

@Controller('health')
export class HealthController {
  @Get('live')
  live(): HealthResponse {
    return this.response();
  }

  @Get('ready')
  ready(): HealthResponse {
    return this.response();
  }

  private response(): HealthResponse {
    return {
      role: 'api',
      service: SERVICE_NAME,
      status: 'ok',
    };
  }
}
