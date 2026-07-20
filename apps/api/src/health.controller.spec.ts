import { ServiceUnavailableException } from '@nestjs/common';

import type { DatabaseReadiness, DatabaseService } from '@aiflow/database';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  const createController = (readiness: DatabaseReadiness): HealthController =>
    new HealthController({
      checkReadiness: jest.fn().mockResolvedValue(readiness),
    } as unknown as DatabaseService);

  it('reports liveness without querying a dependency', () => {
    const controller = createController({ status: 'ready' });

    expect(controller.live()).toEqual({
      role: 'api',
      service: 'aiflow-engine',
      status: 'ok',
    });
  });

  it('reports dependency readiness', async () => {
    const controller = createController({ status: 'ready' });

    await expect(controller.ready()).resolves.toEqual({
      dependencies: { database: 'ready' },
      role: 'api',
      service: 'aiflow-engine',
      status: 'ok',
    });
  });

  it('returns a safe unavailable response', async () => {
    const controller = createController({
      code: 'DATABASE_UNAVAILABLE',
      status: 'unavailable',
    });

    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(controller.ready()).rejects.toMatchObject({
      response: {
        dependencies: { database: 'unavailable' },
        error: { code: 'DATABASE_UNAVAILABLE' },
        status: 'unavailable',
      },
    });
  });
});
