import type { IncomingHttpHeaders } from 'node:http';

import { resolveCorrelationId, type RequestContextStore } from '@aiflow/core';
import type { StructuredLogger } from '@aiflow/observability';

const CORRELATION_HEADER = 'X-Correlation-ID';
const MAX_LOGGED_PATH_LENGTH = 2_048;

interface HttpRequest {
  headers: IncomingHttpHeaders;
  method?: string;
  originalUrl?: string;
  url?: string;
}

interface HttpResponse {
  once(event: 'close' | 'finish', listener: () => void): this;
  setHeader(name: string, value: string): void;
  statusCode: number;
}

export type RequestContextMiddleware = (
  request: HttpRequest,
  response: HttpResponse,
  next: () => void,
) => void;

const safePath = (request: HttpRequest): string => {
  const path = (request.originalUrl ?? request.url ?? '/').split('?', 1)[0];
  return (path || '/').slice(0, MAX_LOGGED_PATH_LENGTH);
};

export const createRequestContextMiddleware =
  (
    contextStore: RequestContextStore,
    logger: StructuredLogger,
  ): RequestContextMiddleware =>
  (request, response, next): void => {
    const correlationId = resolveCorrelationId(
      request.headers['x-correlation-id'],
    );
    const startedAt = process.hrtime.bigint();
    let logged = false;

    response.setHeader(CORRELATION_HEADER, correlationId);

    const logCompletion = (outcome: 'ABORTED' | 'COMPLETED'): void => {
      if (logged) {
        return;
      }

      logged = true;
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      logger.info(
        {
          correlationId,
          durationMs: Math.round(durationMs * 100) / 100,
          event: 'http.request.completed',
          method: request.method ?? 'UNKNOWN',
          outcome,
          path: safePath(request),
          statusCode: response.statusCode,
        },
        'HTTP request completed',
      );
    };

    contextStore.run({ correlationId }, () => {
      response.once('finish', () => logCompletion('COMPLETED'));
      response.once('close', () => logCompletion('ABORTED'));
      next();
    });
  };
