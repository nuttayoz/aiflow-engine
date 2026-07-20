import 'reflect-metadata';

import { loadDatabaseMigrationConfig, loadRuntimeConfig } from '@aiflow/config';
import { createStructuredLogger, toSafeErrorLog } from '@aiflow/observability';

import { runDatabaseMigrations } from './migration-runner';

let logger = createStructuredLogger({
  environment: 'bootstrap',
  level: 'info',
  role: 'migrate',
});

const migrate = async (): Promise<void> => {
  const runtimeConfig = loadRuntimeConfig('migrate');
  const databaseConfig = loadDatabaseMigrationConfig();

  logger = createStructuredLogger({
    environment: runtimeConfig.environment,
    level: runtimeConfig.logLevel,
    role: runtimeConfig.role,
  });

  const applied = await runDatabaseMigrations(databaseConfig);
  logger.info(
    {
      appliedCount: applied.length,
      event: 'database.migrations.completed',
      migrations: applied.map((migration) => migration.name),
    },
    'Database migrations completed',
  );
};

void migrate().catch((error: unknown) => {
  logger.fatal(
    { event: 'database.migrations.failed', ...toSafeErrorLog(error) },
    'Database migrations failed',
  );
  process.exitCode = 1;
});
