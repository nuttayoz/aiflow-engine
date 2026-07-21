import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions.js';

import { FoundationSchema1784505600000 } from './1784505600000-foundation-schema';
import { UploadSessions1784592000000 } from './1784592000000-upload-sessions';

export const ENGINE_MIGRATIONS: NonNullable<
  PostgresDataSourceOptions['migrations']
> = [FoundationSchema1784505600000, UploadSessions1784592000000];
