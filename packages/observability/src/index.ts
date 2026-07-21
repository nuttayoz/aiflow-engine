import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';

import { ConfigurationError, type LogLevel } from '@aiflow/config';
import {
  SERVICE_NAME,
  type RequestContextStore,
  type RuntimeProcess,
} from '@aiflow/core';

export * from './runtime-telemetry';

const REDACTED = '[REDACTED]';
const OMITTED_LOG_PAYLOAD = 'Non-scalar log payload omitted';

export interface StructuredLoggerOptions {
  contextStore?: RequestContextStore;
  environment: string;
  level: LogLevel;
  role: RuntimeProcess;
}

export interface SafeErrorLog {
  errorCode?: string;
  errorMessage?: string;
  errorType: string;
}

export type StructuredLogger = Logger;

const redactPaths = [
  'authorization',
  '*.authorization',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'presignedUrl',
  '*.presignedUrl',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const createStructuredLogger = (
  options: StructuredLoggerOptions,
  destination?: DestinationStream,
): StructuredLogger => {
  const loggerOptions: pino.LoggerOptions = {
    base: {
      environment: options.environment,
      role: options.role,
      service: SERVICE_NAME,
    },
    level: options.level,
    messageKey: 'message',
    mixin: () => {
      const context = options.contextStore?.current();
      return context === undefined
        ? {}
        : { correlationId: context.correlationId };
    },
    redact: {
      censor: REDACTED,
      paths: redactPaths,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, destination);
};

export const toSafeErrorLog = (error: unknown): SafeErrorLog => {
  if (error instanceof ConfigurationError) {
    return {
      errorCode: error.code,
      errorMessage: error.message,
      errorType: error.name,
    };
  }

  return {
    errorType: error instanceof Error ? error.name : 'UnknownError',
  };
};

const scalarMessage = (message: unknown): string => {
  if (
    typeof message === 'string' ||
    typeof message === 'number' ||
    typeof message === 'boolean'
  ) {
    return String(message);
  }

  return OMITTED_LOG_PAYLOAD;
};

const nestContext = (
  optionalParams: readonly unknown[],
): string | undefined => {
  const candidate = optionalParams.at(-1);
  return typeof candidate === 'string' ? candidate : undefined;
};

export class NestStructuredLogger implements LoggerService {
  constructor(private readonly logger: StructuredLogger) {}

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(
      { context: nestContext(optionalParams), event: 'nest.debug' },
      scalarMessage(message),
    );
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(
      { context: nestContext(optionalParams), event: 'nest.error' },
      scalarMessage(message),
    );
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.fatal(
      { context: nestContext(optionalParams), event: 'nest.fatal' },
      scalarMessage(message),
    );
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(
      { context: nestContext(optionalParams), event: 'nest.log' },
      scalarMessage(message),
    );
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace(
      { context: nestContext(optionalParams), event: 'nest.verbose' },
      scalarMessage(message),
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(
      { context: nestContext(optionalParams), event: 'nest.warn' },
      scalarMessage(message),
    );
  }
}
