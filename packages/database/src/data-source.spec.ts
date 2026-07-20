import type { DatabaseRuntimeConfig } from '@aiflow/config';

import {
  createApplicationDataSource,
  createMigrationBootstrapDataSource,
  createMigrationDataSource,
} from './data-source';

describe('database data sources', () => {
  const config: DatabaseRuntimeConfig = {
    connectionTimeoutMs: 5000,
    idleTransactionTimeoutMs: 10000,
    poolMax: 5,
    schema: 'aiflow',
    sslMode: 'verify-full',
    statementTimeoutMs: 30000,
    url: 'postgresql://runtime:secret@database.example/aiflow',
  };

  it('creates a bounded runtime source without synchronization or migrations', () => {
    const dataSource = createApplicationDataSource(config, 'worker');

    expect(dataSource.options).toMatchObject({
      applicationName: 'aiflow-engine-worker',
      connectTimeoutMS: 5000,
      entities: [],
      installExtensions: false,
      logging: false,
      migrations: [],
      migrationsRun: false,
      migrationsTableName: 'typeorm_migrations',
      migrationsTransactionMode: 'all',
      poolSize: 5,
      schema: 'aiflow',
      ssl: { rejectUnauthorized: true },
      synchronize: false,
      type: 'postgres',
    });
  });

  it('keeps the migration source explicit and separate', () => {
    const migration = class TestMigration {};
    const dataSource = createMigrationDataSource(config, [migration]);

    expect(dataSource.options).toMatchObject({
      applicationName: 'aiflow-engine-migrate',
      migrations: [migration],
      migrationsRun: false,
      synchronize: false,
    });
  });

  it('uses a schema-neutral source only for migration bootstrap', () => {
    const dataSource = createMigrationBootstrapDataSource(config);

    expect(dataSource.options).toMatchObject({
      applicationName: 'aiflow-engine-migrate-bootstrap',
      migrations: [],
      synchronize: false,
    });
    expect(dataSource.options).toHaveProperty('schema', undefined);
  });
});
