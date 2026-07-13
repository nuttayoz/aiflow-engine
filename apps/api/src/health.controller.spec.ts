import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('reports liveness', () => {
    expect(controller.live()).toEqual({
      role: 'api',
      service: 'aiflow-engine',
      status: 'ok',
    });
  });

  it('reports readiness', () => {
    expect(controller.ready()).toEqual(controller.live());
  });
});
