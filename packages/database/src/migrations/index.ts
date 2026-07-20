import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions.js';

export const ENGINE_MIGRATIONS: NonNullable<
  PostgresDataSourceOptions['migrations']
> = [];
