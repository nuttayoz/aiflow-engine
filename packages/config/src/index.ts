import type { RuntimeProcess } from '@aiflow/core';

const DEFAULT_API_HOST = '0.0.0.0';
const DEFAULT_API_PORT = 3000;
const DEFAULT_DATABASE_SCHEMA = 'aiflow';
const DEFAULT_DATABASE_POOL_MAX = 5;
const DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;
const DEFAULT_RABBITMQ_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_RABBITMQ_PREFETCH = 10;
const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000;

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
const S3_ENCRYPTION_MODES = ['AES256', 'aws:kms'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];
export type S3EncryptionMode = (typeof S3_ENCRYPTION_MODES)[number];
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
  role: RuntimeProcess;
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

export interface RabbitMqRuntimeConfig {
  connectionTimeoutMs: number;
  prefetch: number;
  url: string;
}

export interface S3RuntimeConfig {
  allowChecksumMetadataFallback: boolean;
  bucket: string;
  encryptionMode: S3EncryptionMode;
  endpoint?: string;
  forcePathStyle: boolean;
  kmsKeyId?: string;
  region: string;
  requestTimeoutMs: number;
}

export interface ObservabilityRuntimeConfig {
  metricsEnabled: boolean;
  metricsHost: string;
  metricsPort: number;
  sentryDsn?: string;
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

const readBoolean = (
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return defaultValue;
  }
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new ConfigurationError(`${name} must be true or false`);
};

const readDatabaseUrl = (name: string, value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigurationError(`${name} is required`);
  }

  const normalized = value.trim();

  try {
    const parsed = new URL(normalized);

    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new ConfigurationError(
      `${name} must be a valid PostgreSQL connection URL`,
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

const readRabbitMqUrl = (
  value: string | undefined,
  nodeEnvironment: NodeEnvironment,
): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigurationError('RABBITMQ_URL is required');
  }

  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') {
      throw new Error('unsupported protocol');
    }
    if (nodeEnvironment === 'production' && parsed.protocol !== 'amqps:') {
      throw new Error('TLS required');
    }
  } catch {
    throw new ConfigurationError(
      nodeEnvironment === 'production'
        ? 'RABBITMQ_URL must be a valid TLS RabbitMQ URL'
        : 'RABBITMQ_URL must be a valid RabbitMQ URL',
    );
  }

  return normalized;
};

export const loadRuntimeConfig = (
  role: RuntimeProcess,
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

const loadDatabaseConfig = (
  urlName: 'DATABASE_MIGRATION_URL' | 'DATABASE_URL',
  environment: NodeJS.ProcessEnv,
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
    url: readDatabaseUrl(urlName, environment[urlName]),
  };
};

export const loadDatabaseRuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseRuntimeConfig => loadDatabaseConfig('DATABASE_URL', environment);

export const loadDatabaseMigrationConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseRuntimeConfig =>
  loadDatabaseConfig('DATABASE_MIGRATION_URL', environment);

export const loadRabbitMqRuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): RabbitMqRuntimeConfig => {
  const nodeEnvironment = readEnum(
    'NODE_ENV',
    environment.NODE_ENV,
    NODE_ENVIRONMENTS,
    'development',
  );

  return {
    connectionTimeoutMs: readInteger(
      environment.RABBITMQ_CONNECTION_TIMEOUT_MS,
      {
        defaultValue: DEFAULT_RABBITMQ_CONNECTION_TIMEOUT_MS,
        maximum: 60_000,
        minimum: 100,
        name: 'RABBITMQ_CONNECTION_TIMEOUT_MS',
      },
    ),
    prefetch: readInteger(environment.RABBITMQ_PREFETCH, {
      defaultValue: DEFAULT_RABBITMQ_PREFETCH,
      maximum: 500,
      minimum: 1,
      name: 'RABBITMQ_PREFETCH',
    }),
    url: readRabbitMqUrl(environment.RABBITMQ_URL, nodeEnvironment),
  };
};

export const loadS3RuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): S3RuntimeConfig => {
  const nodeEnvironment = readEnum(
    'NODE_ENV',
    environment.NODE_ENV,
    NODE_ENVIRONMENTS,
    'development',
  );
  const bucket = environment.S3_BUCKET?.trim();
  const region = environment.S3_REGION?.trim();
  const endpointValue = environment.S3_ENDPOINT?.trim();
  const encryptionMode = readEnum(
    'S3_ENCRYPTION_MODE',
    environment.S3_ENCRYPTION_MODE,
    S3_ENCRYPTION_MODES,
    nodeEnvironment === 'production' ? 'aws:kms' : 'AES256',
  );
  const kmsKeyId = environment.S3_KMS_KEY_ID?.trim();

  if (
    bucket === undefined ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
  ) {
    throw new ConfigurationError('S3_BUCKET must be a valid bucket name');
  }
  if (region === undefined || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new ConfigurationError('S3_REGION must be a valid AWS Region');
  }
  if (nodeEnvironment === 'production' && encryptionMode !== 'aws:kms') {
    throw new ConfigurationError(
      'S3_ENCRYPTION_MODE must be aws:kms in production',
    );
  }
  const allowChecksumMetadataFallback = readBoolean(
    'S3_ALLOW_CHECKSUM_METADATA_FALLBACK',
    environment.S3_ALLOW_CHECKSUM_METADATA_FALLBACK,
    false,
  );
  if (nodeEnvironment === 'production' && allowChecksumMetadataFallback) {
    throw new ConfigurationError(
      'S3_ALLOW_CHECKSUM_METADATA_FALLBACK must be false in production',
    );
  }
  if (
    encryptionMode === 'aws:kms' &&
    (kmsKeyId === undefined || kmsKeyId.length === 0)
  ) {
    throw new ConfigurationError('S3_KMS_KEY_ID is required for aws:kms');
  }

  let endpoint: string | undefined;
  if (endpointValue !== undefined && endpointValue.length > 0) {
    try {
      const parsed = new URL(endpointValue);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('unsupported protocol');
      }
      if (nodeEnvironment === 'production' && parsed.protocol !== 'https:') {
        throw new Error('TLS required');
      }
      endpoint = parsed.toString().replace(/\/$/, '');
    } catch {
      throw new ConfigurationError(
        nodeEnvironment === 'production'
          ? 'S3_ENDPOINT must be a valid HTTPS URL'
          : 'S3_ENDPOINT must be a valid HTTP or HTTPS URL',
      );
    }
  }

  return {
    allowChecksumMetadataFallback,
    bucket,
    encryptionMode,
    ...(endpoint === undefined ? {} : { endpoint }),
    forcePathStyle: readBoolean(
      'S3_FORCE_PATH_STYLE',
      environment.S3_FORCE_PATH_STYLE,
      endpoint !== undefined,
    ),
    ...(kmsKeyId === undefined || kmsKeyId.length === 0 ? {} : { kmsKeyId }),
    region,
    requestTimeoutMs: readInteger(environment.S3_REQUEST_TIMEOUT_MS, {
      defaultValue: DEFAULT_S3_REQUEST_TIMEOUT_MS,
      maximum: 300_000,
      minimum: 1_000,
      name: 'S3_REQUEST_TIMEOUT_MS',
    }),
  };
};

export const loadObservabilityRuntimeConfig = (
  role: RuntimeProcess,
  environment: NodeJS.ProcessEnv = process.env,
): ObservabilityRuntimeConfig => {
  const nodeEnvironment = readEnum(
    'NODE_ENV',
    environment.NODE_ENV,
    NODE_ENVIRONMENTS,
    'development',
  );
  const sentryDsnValue = environment.SENTRY_DSN?.trim();
  let sentryDsn: string | undefined;
  if (sentryDsnValue !== undefined && sentryDsnValue.length > 0) {
    try {
      const parsed = new URL(sentryDsnValue);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('unsupported protocol');
      }
      if (nodeEnvironment === 'production' && parsed.protocol !== 'https:') {
        throw new Error('TLS required');
      }
      sentryDsn = sentryDsnValue;
    } catch {
      throw new ConfigurationError(
        nodeEnvironment === 'production'
          ? 'SENTRY_DSN must be a valid HTTPS URL'
          : 'SENTRY_DSN must be a valid HTTP or HTTPS URL',
      );
    }
  }

  const defaultPort =
    role === 'api'
      ? 9464
      : role === 'worker'
        ? 9465
        : role === 'scheduler'
          ? 9466
          : 9467;
  return {
    metricsEnabled: readBoolean(
      'METRICS_ENABLED',
      environment.METRICS_ENABLED,
      role !== 'migrate',
    ),
    metricsHost: environment.METRICS_HOST?.trim() || '0.0.0.0',
    metricsPort: readInteger(environment.METRICS_PORT, {
      defaultValue: defaultPort,
      maximum: 65_535,
      minimum: 1,
      name: 'METRICS_PORT',
    }),
    ...(sentryDsn === undefined ? {} : { sentryDsn }),
  };
};
