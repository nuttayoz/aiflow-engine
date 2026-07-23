import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions.js';

import { FoundationSchema1784505600000 } from './1784505600000-foundation-schema';
import { UploadSessions1784592000000 } from './1784592000000-upload-sessions';
import { UploadSessionParts1784678400000 } from './1784678400000-upload-session-parts';
import { Phase2Pipeline1784764800000 } from './1784764800000-phase2-pipeline';
import { SharePointEntry1784851200000 } from './1784851200000-sharepoint-entry';

export const ENGINE_MIGRATIONS: NonNullable<
  PostgresDataSourceOptions['migrations']
> = [
  FoundationSchema1784505600000,
  UploadSessions1784592000000,
  UploadSessionParts1784678400000,
  Phase2Pipeline1784764800000,
  SharePointEntry1784851200000,
];
