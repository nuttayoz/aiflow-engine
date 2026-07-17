import { EventEmitter } from 'node:events';

import { RequestContextStore } from '@aiflow/core';
import type { StructuredLogger } from '@aiflow/observability';

import { createRequestContextMiddleware } from './request-context.middleware';

class TestResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  statusCode = 204;

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

describe('createRequestContextMiddleware', () => {
  it('propagates a safe correlation ID and logs no query or headers', () => {
    const contextStore = new RequestContextStore();
    const info = jest.fn();
    const logger = { info } as unknown as StructuredLogger;
    const response = new TestResponse();
    const middleware = createRequestContextMiddleware(contextStore, logger);

    middleware(
      {
        headers: {
          authorization: 'Bearer secret-token',
          'x-correlation-id': 'gateway-request-id',
        },
        method: 'GET',
        originalUrl: '/health/ready?token=query-secret',
      },
      response,
      () => {
        expect(contextStore.current()?.correlationId).toBe(
          'gateway-request-id',
        );
      },
    );
    response.emit('finish');
    response.emit('close');

    expect(response.headers.get('X-Correlation-ID')).toBe('gateway-request-id');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'gateway-request-id',
        event: 'http.request.completed',
        method: 'GET',
        outcome: 'COMPLETED',
        path: '/health/ready',
        statusCode: 204,
      }),
      'HTTP request completed',
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(info.mock.calls)).not.toContain('query-secret');
    expect(contextStore.current()).toBeUndefined();
  });
});
