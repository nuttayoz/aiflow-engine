import type { Migration } from 'typeorm';

import type { DatabaseRuntimeConfig } from '@aiflow/config';

import {
  createMigrationBootstrapDataSource,
  createMigrationDataSource,
  type DatabaseMigrations,
} from './data-source';
import { ENGINE_MIGRATIONS } from './migrations';

export const runDatabaseMigrations = async (
  config: DatabaseRuntimeConfig,
  migrations: DatabaseMigrations = ENGINE_MIGRATIONS,
): Promise<readonly Migration[]> => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(config.schema)) {
    throw new Error('Database schema identifier is invalid');
  }

  const bootstrapDataSource = createMigrationBootstrapDataSource(config);
  const dataSource = createMigrationDataSource(config, migrations);

  try {
    await bootstrapDataSource.initialize();
    const [schema] = (await bootstrapDataSource.query(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_namespace
            WHERE nspname = $1
          ) AS "exists",
          COALESCE((
            SELECT pg_get_userbyid(nspowner) = current_user
            FROM pg_namespace
            WHERE nspname = $1
          ), false) AS "ownedByCurrentUser"
      `,
      [config.schema],
    )) as [{ exists: boolean; ownedByCurrentUser: boolean }];

    if (schema.exists && !schema.ownedByCurrentUser) {
      throw new Error('Migration identity must own the database schema');
    }

    if (!schema.exists) {
      await bootstrapDataSource.query(
        `CREATE SCHEMA "${config.schema}" AUTHORIZATION CURRENT_USER`,
      );
    }
  } finally {
    if (bootstrapDataSource.isInitialized) {
      await bootstrapDataSource.destroy();
    }
  }

  try {
    await dataSource.initialize();
    const lock = dataSource.createQueryRunner();
    await lock.connect();
    try {
      await lock.query(
        "SELECT pg_advisory_lock(hashtext('aiflow-engine-migrate'), hashtext($1))",
        [config.schema],
      );
      return await dataSource.runMigrations({ transaction: 'all' });
    } finally {
      try {
        await lock.query(
          "SELECT pg_advisory_unlock(hashtext('aiflow-engine-migrate'), hashtext($1))",
          [config.schema],
        );
      } finally {
        await lock.release();
      }
    }
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
};
