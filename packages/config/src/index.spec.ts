import {
  ConfigurationError,
  loadApiRuntimeConfig,
  loadDatabaseMigrationConfig,
  loadDatabaseRuntimeConfig,
  loadRuntimeConfig,
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
