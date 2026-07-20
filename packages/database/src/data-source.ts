import { DataSource } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions.js';

import type { DatabaseRuntimeConfig } from '@aiflow/config';
import type { RuntimeRole } from '@aiflow/core';

import { ENGINE_MIGRATIONS } from './migrations';

export type DatabaseMigrations = NonNullable<
  PostgresDataSourceOptions['migrations']
>;

const sslOptions = (
  mode: DatabaseRuntimeConfig['sslMode'],
): false | { rejectUnauthorized: boolean } => {
  if (mode === 'disable') {
    return false;
  }

  return { rejectUnauthorized: mode === 'verify-full' };
};

const options = (
  config: DatabaseRuntimeConfig,
  applicationName: string,
  migrations: DatabaseMigrations,
): PostgresDataSourceOptions => ({
  applicationName,
  connectTimeoutMS: config.connectionTimeoutMs,
  entities: [],
  extra: {
    idle_in_transaction_session_timeout: config.idleTransactionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
  },
  installExtensions: false,
  logging: false,
  migrations,
  migrationsRun: false,
  migrationsTableName: 'typeorm_migrations',
  migrationsTransactionMode: 'all',
  poolSize: config.poolMax,
  schema: config.schema,
  ssl: sslOptions(config.sslMode),
  synchronize: false,
  type: 'postgres',
  url: config.url,
});

export const createApplicationDataSource = (
  config: DatabaseRuntimeConfig,
  role: RuntimeRole,
): DataSource => new DataSource(options(config, `aiflow-engine-${role}`, []));

export const createMigrationDataSource = (
  config: DatabaseRuntimeConfig,
  migrations: DatabaseMigrations = ENGINE_MIGRATIONS,
): DataSource =>
  new DataSource(options(config, 'aiflow-engine-migrate', migrations));

export const createMigrationBootstrapDataSource = (
  config: DatabaseRuntimeConfig,
): DataSource =>
  new DataSource({
    ...options(config, 'aiflow-engine-migrate-bootstrap', []),
    schema: undefined,
  });
