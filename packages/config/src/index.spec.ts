import {
  ConfigurationError,
  loadApiRuntimeConfig,
  loadDatabaseMigrationConfig,
  loadDatabaseRuntimeConfig,
  loadObservabilityRuntimeConfig,
  loadRabbitMqRuntimeConfig,
  loadRuntimeConfig,
  loadS3RuntimeConfig,
  loadSharePointRuntimeConfig,
} from './index';

describe('runtime configuration', () => {
  it('uses safe runtime defaults', () => {
    expect(loadRuntimeConfig('worker', {})).toEqual({
      environment: 'development',
      logLevel: 'info',
      role: 'worker',
    });
  });

  it('rejects unknown environments and log levels', () => {
    expect(() => loadRuntimeConfig('api', { NODE_ENV: 'preview' })).toThrow(
      'NODE_ENV must be one of: development, test, production',
    );
    expect(() => loadRuntimeConfig('api', { LOG_LEVEL: 'verbose' })).toThrow(
      'LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal, silent',
    );
  });

  it('uses API defaults', () => {
    expect(loadApiRuntimeConfig({})).toEqual({
      host: '0.0.0.0',
      port: 3000,
    });
  });

  it('rejects an invalid API port with a safe configuration error', () => {
    expect(() => loadApiRuntimeConfig({ API_PORT: '70000' })).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );

    try {
      loadApiRuntimeConfig({ API_PORT: '70000' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ code: 'CONFIGURATION_INVALID' });
    }
  });
});

describe('database runtime configuration', () => {
  const databaseUrl =
    'postgresql://aiflow_app:local-development-only@localhost:5432/aiflow';

  it('loads bounded local defaults without exposing migration credentials', () => {
    expect(loadDatabaseRuntimeConfig({ DATABASE_URL: databaseUrl })).toEqual({
      connectionTimeoutMs: 5000,
      idleTransactionTimeoutMs: 10000,
      poolMax: 5,
      schema: 'aiflow',
      sslMode: 'disable',
      statementTimeoutMs: 30000,
      url: databaseUrl,
    });
  });

  it('requires a valid PostgreSQL URL without echoing its value', () => {
    expect(() => loadDatabaseRuntimeConfig({})).toThrow(
      'DATABASE_URL is required',
    );
    expect(() =>
      loadDatabaseRuntimeConfig({ DATABASE_URL: 'https://secret@example.com' }),
    ).toThrow('DATABASE_URL must be a valid PostgreSQL connection URL');
  });

  it('loads migration credentials only through the migration boundary', () => {
    expect(
      loadDatabaseMigrationConfig({ DATABASE_MIGRATION_URL: databaseUrl }).url,
    ).toBe(databaseUrl);
    expect(() =>
      loadDatabaseMigrationConfig({ DATABASE_URL: databaseUrl }),
    ).toThrow('DATABASE_MIGRATION_URL is required');
  });

  it('requires verified TLS in production', () => {
    expect(
      loadDatabaseRuntimeConfig({
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'production',
      }).sslMode,
    ).toBe('verify-full');

    expect(() =>
      loadDatabaseRuntimeConfig({
        DATABASE_SSL_MODE: 'require',
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'production',
      }),
    ).toThrow('DATABASE_SSL_MODE must be verify-full in production');
  });

  it('rejects unsafe schema names and unbounded pools', () => {
    expect(() =>
      loadDatabaseRuntimeConfig({
        DATABASE_SCHEMA: 'public; DROP SCHEMA public',
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow('DATABASE_SCHEMA must be a lowercase PostgreSQL identifier');

    expect(() =>
      loadDatabaseRuntimeConfig({
        DATABASE_POOL_MAX: '101',
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow('DATABASE_POOL_MAX must be an integer between 1 and 100');
  });
});

describe('RabbitMQ runtime configuration', () => {
  it('loads bounded local broker settings', () => {
    expect(
      loadRabbitMqRuntimeConfig({
        NODE_ENV: 'development',
        RABBITMQ_PREFETCH: '25',
        RABBITMQ_URL: 'amqp://user:secret@localhost:55672/aiflow',
      }),
    ).toMatchObject({ prefetch: 25 });
  });

  it('requires TLS in production without disclosing credentials', () => {
    expect(() =>
      loadRabbitMqRuntimeConfig({
        NODE_ENV: 'production',
        RABBITMQ_URL: 'amqp://user:super-secret@rabbitmq/aiflow',
      }),
    ).toThrow('RABBITMQ_URL must be a valid TLS RabbitMQ URL');
  });
});

describe('S3 runtime configuration', () => {
  it('loads the local S3-compatible endpoint without accepting secrets', () => {
    expect(
      loadS3RuntimeConfig({
        S3_BUCKET: 'aiflow-local',
        S3_ENDPOINT: 'http://localhost:55674',
        S3_REGION: 'us-east-1',
      }),
    ).toEqual({
      allowChecksumMetadataFallback: false,
      bucket: 'aiflow-local',
      encryptionMode: 'AES256',
      endpoint: 'http://localhost:55674',
      forcePathStyle: true,
      region: 'us-east-1',
      requestTimeoutMs: 30000,
    });
  });

  it('requires KMS and TLS-compatible settings in production', () => {
    expect(() =>
      loadS3RuntimeConfig({
        NODE_ENV: 'production',
        S3_BUCKET: 'aiflow-production',
        S3_REGION: 'ap-southeast-1',
      }),
    ).toThrow('S3_KMS_KEY_ID is required for aws:kms');

    expect(() =>
      loadS3RuntimeConfig({
        NODE_ENV: 'production',
        S3_BUCKET: 'aiflow-production',
        S3_ENDPOINT: 'http://s3.internal',
        S3_KMS_KEY_ID: 'alias/aiflow',
        S3_REGION: 'ap-southeast-1',
      }),
    ).toThrow('S3_ENDPOINT must be a valid HTTPS URL');
  });
});

describe('SharePoint runtime configuration', () => {
  const rootKeyBase64 = Buffer.from(
    'aiflow-local-sharepoint-root-key-1',
  ).toString('base64');
  const callbackUrl =
    'http://localhost:3000/provider-callbacks/v1/microsoft-graph/sharepoint';

  it('loads bounded local key material and the fixed callback path', () => {
    expect(
      loadSharePointRuntimeConfig({
        SHAREPOINT_CALLBACK_URL: callbackUrl,
        SHAREPOINT_KEY_VERSION: '3',
        SHAREPOINT_ROOT_KEY_BASE64: rootKeyBase64,
      }),
    ).toEqual({
      allowedConsentRedirectOrigins: ['http://localhost:3001'],
      allowedDownloadHostSuffixes: ['.sharepoint.com', '.1drv.com'],
      callbackUrl,
      currentKeyVersion: 3,
      graphMode: 'FAKE',
      graphRequestTimeoutMs: 30_000,
      rootKey: new Uint8Array(
        Buffer.from('aiflow-local-sharepoint-root-key-1'),
      ),
    });
  });

  it('requires HTTPS in production and at least 32 key bytes', () => {
    expect(() =>
      loadSharePointRuntimeConfig({
        NODE_ENV: 'production',
        SHAREPOINT_CALLBACK_URL: callbackUrl,
        SHAREPOINT_CONSENT_REDIRECT_ORIGINS: 'https://portal.example.com',
        SHAREPOINT_GRAPH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
        SHAREPOINT_GRAPH_CLIENT_SECRET: 'production-test-secret',
        SHAREPOINT_ROOT_KEY_BASE64: rootKeyBase64,
      }),
    ).toThrow(
      'SHAREPOINT_CALLBACK_URL must be the public HTTPS SharePoint callback',
    );
    expect(() =>
      loadSharePointRuntimeConfig({
        SHAREPOINT_CALLBACK_URL: callbackUrl,
        SHAREPOINT_ROOT_KEY_BASE64: Buffer.from('too-short').toString('base64'),
      }),
    ).toThrow('SHAREPOINT_ROOT_KEY_BASE64 must decode to 32-64 bytes');
  });
});

describe('observability runtime configuration', () => {
  it('uses separate local metrics ports for independently run roles', () => {
    expect(loadObservabilityRuntimeConfig('api', {}).metricsPort).toBe(9464);
    expect(loadObservabilityRuntimeConfig('worker', {}).metricsPort).toBe(9465);
    expect(loadObservabilityRuntimeConfig('scheduler', {}).metricsPort).toBe(
      9466,
    );
  });

  it('rejects a non-TLS production Sentry DSN without echoing it', () => {
    expect(() =>
      loadObservabilityRuntimeConfig('api', {
        NODE_ENV: 'production',
        SENTRY_DSN: 'http://public:secret@sentry.example/1',
      }),
    ).toThrow('SENTRY_DSN must be a valid HTTPS URL');
  });
});
