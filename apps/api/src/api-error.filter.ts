import { Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';

import type { AuthorizedRequest } from './api-auth';

const statusFor = (code: string): number => {
  if (code.endsWith('_NOT_FOUND') || code === 'RESOURCE_NOT_FOUND') return 404;
  if (code === 'PROJECT_ACCESS_DENIED' || code === 'PERMISSION_DENIED')
    return 403;
  if (code === 'AUTHENTICATION_REQUIRED') return 401;
  if (code.includes('CONFLICT') || code === 'IDEMPOTENCY_KEY_REUSED')
    return 409;
  if (code.endsWith('_IN_PROGRESS')) return 409;
  if (code.endsWith('_ARCHIVED')) return 409;
  if (code.includes('NOT_ACCEPTING')) return 409;
  if (code.includes('NOT_ALLOWED')) return 409;
  if (code.includes('UNAVAILABLE')) return 503;
  return 400;
};

const safeCode = (error: unknown): string =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{2,179}$/u.test(error.message)
    ? error.message
    : 'INTERNAL_ERROR';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AuthorizedRequest>();
    const response = http.getResponse<Response>();
    const code = safeCode(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : code === 'INTERNAL_ERROR'
          ? 500
          : statusFor(code);
    response.status(status).json({
      error: {
        code,
        correlationId: request.aiflowCorrelationId ?? 'unavailable',
        message:
          code === 'INTERNAL_ERROR'
            ? 'The request could not be completed'
            : code.toLowerCase().replaceAll('_', ' '),
        retryable: status >= 500,
      },
    });
  }
}
