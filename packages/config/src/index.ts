import type { RuntimeRole } from '@aiflow/core';

const DEFAULT_API_HOST = '0.0.0.0';
const DEFAULT_API_PORT = 3000;
const DEFAULT_DATABASE_SCHEMA = 'aiflow';
const DEFAULT_DATABASE_POOL_MAX = 5;
const DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;
const DATABASE_SSL_MODES = ['disable', 'require', 'verify-full'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];
export class ConfigurationError extends Error {
  readonly code = 'CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface RuntimeConfig {
  environment: NodeEnvironment;
  logLevel: LogLevel;
  role: RuntimeRole;
}

export interface ApiRuntimeConfig {
  host: string;
  port: number;
}

export interface DatabaseRuntimeConfig {
  connectionTimeoutMs: number;
  idleTransactionTimeoutMs: number;
  poolMax: number;
  schema: string;
  sslMode: DatabaseSslMode;
  statementTimeoutMs: number;
  url: string;
}

interface IntegerOptions {
  defaultValue: number;
  maximum: number;
  minimum: number;
  name: string;
}

const readEnum = <T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
): T => {
  const normalized = value?.trim() || defaultValue;

  if (!allowed.includes(normalized as T)) {
    throw new ConfigurationError(
      `${name} must be one of: ${allowed.join(', ')}`,
    );
  }

  return normalized as T;
};

const readInteger = (
  value: string | undefined,
  options: IntegerOptions,
): number => {
  if (value === undefined || value.trim().length === 0) {
    return options.defaultValue;
  }

  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < options.minimum ||
    parsed > options.maximum
  ) {
    throw new ConfigurationError(
      `${options.name} must be an integer between ${options.minimum} and ${options.maximum}`,
    );
  }

  return parsed;
};

const readDatabaseUrl = (value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigurationError('DATABASE_URL is required');
  }

  const normalized = value.trim();

  try {
    const parsed = new URL(normalized);

    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new ConfigurationError(
      'DATABASE_URL must be a valid PostgreSQL connection URL',
    );
  }

  return normalized;
};

const readDatabaseSchema = (value: string | undefined): string => {
  const normalized = value?.trim() || DEFAULT_DATABASE_SCHEMA;

  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(normalized)) {
    throw new ConfigurationError(
      'DATABASE_SCHEMA must be a lowercase PostgreSQL identifier',
    );
  }

  return normalized;
};

export const loadRuntimeConfig = (
  role: RuntimeRole,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig => ({
  environment: readEnum(
    'NODE_ENV',
    environment.NODE_ENV,
    NODE_ENVIRONMENTS,
    'development',
  ),
  logLevel: readEnum('LOG_LEVEL', environment.LOG_LEVEL, LOG_LEVELS, 'info'),
  role,
});

export const loadApiRuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ApiRuntimeConfig => ({
  host: environment.API_HOST?.trim() || DEFAULT_API_HOST,
  port: readInteger(environment.API_PORT, {
    defaultValue: DEFAULT_API_PORT,
    maximum: 65_535,
    minimum: 1,
    name: 'API_PORT',
  }),
});

export const loadDatabaseRuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseRuntimeConfig => {
  const nodeEnvironment = readEnum(
    'NODE_ENV',
    environment.NODE_ENV,
    NODE_ENVIRONMENTS,
    'development',
  );
  const sslMode = readEnum(
    'DATABASE_SSL_MODE',
    environment.DATABASE_SSL_MODE,
    DATABASE_SSL_MODES,
    nodeEnvironment === 'production' ? 'verify-full' : 'disable',
  );

  if (nodeEnvironment === 'production' && sslMode !== 'verify-full') {
    throw new ConfigurationError(
      'DATABASE_SSL_MODE must be verify-full in production',
    );
  }

  return {
    connectionTimeoutMs: readInteger(
      environment.DATABASE_CONNECTION_TIMEOUT_MS,
      {
        defaultValue: DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS,
        maximum: 60_000,
        minimum: 100,
        name: 'DATABASE_CONNECTION_TIMEOUT_MS',
      },
    ),
    idleTransactionTimeoutMs: readInteger(
      environment.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
      {
        defaultValue: DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
        maximum: 300_000,
        minimum: 1_000,
        name: 'DATABASE_IDLE_TRANSACTION_TIMEOUT_MS',
      },
    ),
    poolMax: readInteger(environment.DATABASE_POOL_MAX, {
      defaultValue: DEFAULT_DATABASE_POOL_MAX,
      maximum: 100,
      minimum: 1,
      name: 'DATABASE_POOL_MAX',
    }),
    schema: readDatabaseSchema(environment.DATABASE_SCHEMA),
    sslMode,
    statementTimeoutMs: readInteger(environment.DATABASE_STATEMENT_TIMEOUT_MS, {
      defaultValue: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
      maximum: 300_000,
      minimum: 1_000,
      name: 'DATABASE_STATEMENT_TIMEOUT_MS',
    }),
    url: readDatabaseUrl(environment.DATABASE_URL),
  };
};
