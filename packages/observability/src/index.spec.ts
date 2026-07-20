import type { DestinationStream } from 'pino';

import { ConfigurationError } from '@aiflow/config';
import { RequestContextStore } from '@aiflow/core';

import { createStructuredLogger, toSafeErrorLog } from './index';

describe('createStructuredLogger', () => {
  it('emits JSON with runtime and request correlation fields', () => {
    const contextStore = new RequestContextStore();
    let output = '';
    const destination: DestinationStream = {
      write(chunk: string): void {
        output += chunk;
      },
    };
    const logger = createStructuredLogger(
      {
        contextStore,
        environment: 'test',
        level: 'info',
        role: 'api',
      },
      destination,
    );

    contextStore.run({ correlationId: 'correlation-id' }, () => {
      logger.info({ event: 'test.event' }, 'safe message');
    });

    expect(JSON.parse(output)).toMatchObject({
      correlationId: 'correlation-id',
      environment: 'test',
      event: 'test.event',
      message: 'safe message',
      role: 'api',
      service: 'aiflow-engine',
    });
  });

  it('redacts common secret fields defensively', () => {
    let output = '';
    const destination: DestinationStream = {
      write(chunk: string): void {
        output += chunk;
      },
    };
    const logger = createStructuredLogger(
      { environment: 'test', level: 'info', role: 'worker' },
      destination,
    );

    logger.info(
      {
        authorization: 'Bearer access-token',
        connection: { password: 'database-password' },
        event: 'test.redaction',
      },
      'redacted message',
    );

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record.authorization).toBe('[REDACTED]');
    expect(record.connection).toEqual({ password: '[REDACTED]' });
    expect(output).not.toContain('access-token');
    expect(output).not.toContain('database-password');
  });
});

describe('toSafeErrorLog', () => {
  it('includes safe configuration details', () => {
    expect(
      toSafeErrorLog(new ConfigurationError('LOG_LEVEL is invalid')),
    ).toEqual({
      errorCode: 'CONFIGURATION_INVALID',
      errorMessage: 'LOG_LEVEL is invalid',
      errorType: 'ConfigurationError',
    });
  });

  it('does not expose an arbitrary error message', () => {
    expect(
      toSafeErrorLog(new Error('postgresql://user:secret@database')),
    ).toEqual({ errorType: 'Error' });
  });
});
