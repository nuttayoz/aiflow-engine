import type { DataSource } from 'typeorm';

import {
  isSharePointConnectionConfiguration,
  type SharePointConnectionAuthorityPort,
} from '@aiflow/connector-microsoft-sharepoint';

import { table } from './sql';

export class PostgresSharePointConnectionAuthority implements SharePointConnectionAuthorityPort {
  private readonly connections: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.connections = table(schema, 'connections');
  }

  async resolve(input: {
    readonly connectionId: string;
    readonly tenantId: string;
  }) {
    const rows = (await this.dataSource.query(
      `
        SELECT configuration
        FROM ${this.connections}
        WHERE tenant_id = $1
          AND id = $2
          AND connector_id = 'microsoft-sharepoint'
          AND status = 'ACTIVE'
      `,
      [input.tenantId, input.connectionId],
    )) as { configuration: unknown }[];
    const configuration =
      typeof rows[0]?.configuration === 'string'
        ? (JSON.parse(rows[0].configuration) as unknown)
        : rows[0]?.configuration;
    if (!isSharePointConnectionConfiguration(configuration)) {
      throw new Error('SHAREPOINT_CONNECTION_NOT_AUTHORIZED');
    }
    return { externalTenantId: configuration.externalTenantId };
  }
}
