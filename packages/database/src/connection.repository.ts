import type { DataSource } from 'typeorm';

import type {
  ConnectionRecord,
  ConnectionRepository,
  CreateConnectionInput,
} from '@aiflow/connections';

import { table } from './sql';

interface ConnectionRow {
  configuration: ConnectionRecord['configuration'] | string;
  configuration_schema_version: number;
  connector_id: string;
  created_at: Date | string;
  display_name: string;
  health: ConnectionRecord['health'];
  id: string;
  state_version: number | string;
  status: ConnectionRecord['status'];
  tenant_id: string;
  updated_at: Date | string;
}

const mapConnection = (row: ConnectionRow): ConnectionRecord => ({
  configuration:
    typeof row.configuration === 'string'
      ? (JSON.parse(row.configuration) as Readonly<Record<string, unknown>>)
      : row.configuration,
  configurationSchemaVersion: row.configuration_schema_version,
  connectorId: row.connector_id,
  createdAt: new Date(row.created_at),
  displayName: row.display_name,
  health: row.health,
  id: row.id,
  stateVersion: Number(row.state_version),
  status: row.status,
  tenantId: row.tenant_id,
  updatedAt: new Date(row.updated_at),
});

export class PostgresConnectionRepository implements ConnectionRepository {
  private readonly connections: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.connections = table(schema, 'connections');
  }

  async create(input: CreateConnectionInput): Promise<ConnectionRecord> {
    if (
      input.displayName.trim().length === 0 ||
      input.displayName.length > 180 ||
      input.connectorId.trim().length === 0 ||
      input.connectorId.length > 180 ||
      input.configurationSchemaVersion < 1 ||
      !Number.isInteger(input.configurationSchemaVersion)
    ) {
      throw new Error('CONNECTION_INVALID');
    }

    const encoded = JSON.stringify(input.configuration);
    if (Buffer.byteLength(encoded) > 64 * 1024) {
      throw new Error('CONNECTION_CONFIGURATION_TOO_LARGE');
    }

    const rows = (await this.dataSource.query(
      `
        INSERT INTO ${this.connections} (
          id,
          tenant_id,
          connector_id,
          display_name,
          configuration_schema_version,
          configuration,
          secret_reference,
          status,
          health
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'ACTIVE', 'UNKNOWN')
        RETURNING
          id,
          tenant_id,
          connector_id,
          display_name,
          configuration_schema_version,
          configuration,
          status,
          health,
          state_version,
          created_at,
          updated_at
      `,
      [
        input.id,
        input.tenantId,
        input.connectorId,
        input.displayName.trim(),
        input.configurationSchemaVersion,
        encoded,
        input.secretReference ?? null,
      ],
    )) as ConnectionRow[];

    return mapConnection(rows[0]);
  }

  async findById(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | undefined> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          id,
          tenant_id,
          connector_id,
          display_name,
          configuration_schema_version,
          configuration,
          status,
          health,
          state_version,
          created_at,
          updated_at
        FROM ${this.connections}
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, connectionId],
    )) as ConnectionRow[];

    return rows[0] === undefined ? undefined : mapConnection(rows[0]);
  }
}
