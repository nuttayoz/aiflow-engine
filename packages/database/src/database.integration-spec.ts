import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  loadDatabaseMigrationConfig,
  loadDatabaseRuntimeConfig,
} from '@aiflow/config';

import {
  createApplicationDataSource,
  createMigrationDataSource,
} from './data-source';
import { runDatabaseMigrations } from './migration-runner';

class DatabaseContractProbe1770000000000 implements MigrationInterface {
  readonly name = 'DatabaseContractProbe1770000000000';

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE aiflow.database_contract_probe');
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE aiflow.database_contract_probe (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        value text NOT NULL
      )
    `);
  }
}

const connectionUrl = (
  container: StartedPostgreSqlContainer,
  username: string,
  password: string,
): string => {
  const url = new URL(container.getConnectionUri());
  url.username = username;
  url.password = password;
  return url.toString();
};

describe('PostgreSQL foundation', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.4-bookworm')
      .withDatabase('aiflow')
      .withUsername('aiflow_bootstrap')
      .withPassword('local-bootstrap-only')
      .withCopyFilesToContainer([
        {
          source: resolve(
            process.cwd(),
            'infra/postgres/init/001-create-local-identities.sql',
          ),
          target: '/docker-entrypoint-initdb.d/001-create-local-identities.sql',
        },
      ])
      .start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('runs migrations separately and grants runtime DML without DDL', async () => {
    const migrationConfig = loadDatabaseMigrationConfig({
      DATABASE_MIGRATION_URL: connectionUrl(
        container,
        'aiflow_migration',
        'local-migration-only',
      ),
      NODE_ENV: 'test',
    });
    const runtimeConfig = loadDatabaseRuntimeConfig({
      DATABASE_URL: connectionUrl(
        container,
        'aiflow_app',
        'local-application-only',
      ),
      NODE_ENV: 'test',
    });
    const migrations = [DatabaseContractProbe1770000000000];
    const migrationDataSource = createMigrationDataSource(
      migrationConfig,
      migrations,
    );
    const runtimeDataSource = createApplicationDataSource(
      runtimeConfig,
      'worker',
    );

    try {
      await expect(
        runDatabaseMigrations(migrationConfig, migrations),
      ).resolves.toHaveLength(1);
      await migrationDataSource.initialize();

      await runtimeDataSource.initialize();
      await expect(
        runtimeDataSource.query(
          "INSERT INTO aiflow.database_contract_probe (value) VALUES ('ok') RETURNING value",
        ),
      ).resolves.toEqual([{ value: 'ok' }]);
      await expect(
        runtimeDataSource.query(
          "SELECT current_user AS user, current_schema() AS schema, has_schema_privilege(current_user, 'aiflow', 'CREATE') AS can_create",
        ),
      ).resolves.toEqual([
        { can_create: false, schema: 'aiflow', user: 'aiflow_app' },
      ]);
      await expect(
        runtimeDataSource.query('CREATE TABLE aiflow.forbidden (id integer)'),
      ).rejects.toThrow(/permission denied/u);

      await runtimeDataSource.destroy();
      await expect(
        migrationDataSource.undoLastMigration(),
      ).resolves.toBeUndefined();
    } finally {
      if (runtimeDataSource.isInitialized) {
        await runtimeDataSource.destroy();
      }
      if (migrationDataSource.isInitialized) {
        await migrationDataSource.destroy();
      }
    }
  });
});
