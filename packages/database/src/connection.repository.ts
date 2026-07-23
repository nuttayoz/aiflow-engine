import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import type {
  ConnectionActor,
  ConnectionRecord,
  ConnectionRepository,
  CreateConnectionInput,
  RevokeConnectionInput,
  UpdateConnectionInput,
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

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');

const validateIdempotencyKey = (value: string): void => {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error('IDEMPOTENCY_KEY_INVALID');
  }
};

const validateDisplayName = (value: string): void => {
  if (value.trim().length === 0 || value.length > 180) {
    throw new Error('CONNECTION_DISPLAY_NAME_INVALID');
  }
};

export class PostgresConnectionRepository implements ConnectionRepository {
  private readonly auditEvents: string;
  private readonly connections: string;
  private readonly idempotency: string;
  private readonly workflowReferences: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.auditEvents = table(schema, 'audit_events');
    this.connections = table(schema, 'connections');
    this.idempotency = table(schema, 'idempotency_records');
    this.workflowReferences = table(schema, 'workflow_version_connection_refs');
  }

  async create(input: CreateConnectionInput): Promise<ConnectionRecord> {
    validateIdempotencyKey(input.idempotencyKey);
    validateDisplayName(input.displayName);
    if (
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
    const requestFingerprint = fingerprint({
      configuration: input.configuration,
      configurationSchemaVersion: input.configurationSchemaVersion,
      connectorId: input.connectorId,
      displayName: input.displayName.trim(),
    });

    const connectionId = await this.dataSource.transaction(async (manager) => {
      const inserted = (await manager.query(
        `
          INSERT INTO ${this.idempotency} (
            id, tenant_id, operation_scope, idempotency_key,
            request_fingerprint, status, resource_type, resource_id,
            completed_at, expires_at
          ) VALUES (
            $1, $2, 'connection.create', $3, $4, 'COMPLETED',
            'CONNECTION', $5, clock_timestamp(), clock_timestamp() + interval '90 days'
          )
          ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
          RETURNING resource_id
        `,
        [
          randomUUID(),
          input.tenantId,
          input.idempotencyKey,
          requestFingerprint,
          input.id,
        ],
      )) as { resource_id: string }[];
      if (inserted.length === 0) {
        return this.requireIdempotentResource(
          manager,
          input.tenantId,
          'connection.create',
          input.idempotencyKey,
          requestFingerprint,
        );
      }

      await manager.query(
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
      );
      await this.appendAudit(manager, input, 'connection.create', input.id);
      return input.id;
    });

    return this.requireConnection(input.tenantId, connectionId);
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

  async list(
    tenantId: string,
    connectorId?: string,
  ): Promise<readonly ConnectionRecord[]> {
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
        WHERE tenant_id = $1
          AND status <> 'REVOKED'
          AND ($2::varchar IS NULL OR connector_id = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `,
      [tenantId, connectorId ?? null],
    )) as ConnectionRow[];
    return rows.map(mapConnection);
  }

  async update(input: UpdateConnectionInput): Promise<ConnectionRecord> {
    validateIdempotencyKey(input.idempotencyKey);
    validateDisplayName(input.displayName);
    if (
      !Number.isInteger(input.expectedStateVersion) ||
      input.expectedStateVersion < 0
    ) {
      throw new Error('CONNECTION_STATE_VERSION_INVALID');
    }
    const requestFingerprint = fingerprint({
      connectionId: input.connectionId,
      displayName: input.displayName.trim(),
      expectedStateVersion: input.expectedStateVersion,
    });

    await this.dataSource.transaction(async (manager) => {
      const connection = await this.lockConnection(
        manager,
        input.tenantId,
        input.connectionId,
      );
      const replay = await this.findIdempotentResource(
        manager,
        input.tenantId,
        'connection.update',
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        if (replay !== input.connectionId) {
          throw new Error('IDEMPOTENCY_RESOURCE_CONFLICT');
        }
        return;
      }
      if (connection.status === 'REVOKED') {
        throw new Error('CONNECTION_REVOKED');
      }
      if (Number(connection.state_version) !== input.expectedStateVersion) {
        throw new Error('CONNECTION_VERSION_CONFLICT');
      }

      await this.insertIdempotency(
        manager,
        input.tenantId,
        'connection.update',
        input.idempotencyKey,
        requestFingerprint,
        input.connectionId,
      );
      await manager.query(
        `
          UPDATE ${this.connections}
          SET display_name = $3,
              state_version = state_version + 1,
              updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2
        `,
        [input.tenantId, input.connectionId, input.displayName.trim()],
      );
      await this.appendAudit(
        manager,
        input,
        'connection.update',
        input.connectionId,
      );
    });

    return this.requireConnection(input.tenantId, input.connectionId);
  }

  async revoke(input: RevokeConnectionInput): Promise<ConnectionRecord> {
    validateIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprint({
      connectionId: input.connectionId,
    });

    await this.dataSource.transaction(async (manager) => {
      const connection = await this.lockConnection(
        manager,
        input.tenantId,
        input.connectionId,
      );
      const replay = await this.findIdempotentResource(
        manager,
        input.tenantId,
        'connection.revoke',
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay !== undefined) {
        if (replay !== input.connectionId) {
          throw new Error('IDEMPOTENCY_RESOURCE_CONFLICT');
        }
        return;
      }

      if (connection.status !== 'REVOKED') {
        const references = (await manager.query(
          `
            SELECT 1
            FROM ${this.workflowReferences}
            WHERE tenant_id = $1 AND connection_id = $2
            LIMIT 1
          `,
          [input.tenantId, input.connectionId],
        )) as unknown[];
        if (references.length > 0) {
          throw new Error('CONNECTION_REFERENCE_CONFLICT');
        }
      }

      await this.insertIdempotency(
        manager,
        input.tenantId,
        'connection.revoke',
        input.idempotencyKey,
        requestFingerprint,
        input.connectionId,
      );
      if (connection.status !== 'REVOKED') {
        await manager.query(
          `
            UPDATE ${this.connections}
            SET status = 'REVOKED',
                health = 'UNKNOWN',
                state_version = state_version + 1,
                updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2
          `,
          [input.tenantId, input.connectionId],
        );
      }
      await this.appendAudit(
        manager,
        input,
        'connection.revoke',
        input.connectionId,
      );
    });

    return this.requireConnection(input.tenantId, input.connectionId);
  }

  async setHealth(input: {
    readonly actor: ConnectionActor;
    readonly causationId: string;
    readonly connectionId: string;
    readonly correlationId: string;
    readonly health: ConnectionRecord['health'];
    readonly tenantId: string;
  }): Promise<ConnectionRecord> {
    await this.dataSource.transaction(async (manager) => {
      const connection = await this.lockConnection(
        manager,
        input.tenantId,
        input.connectionId,
      );
      if (connection.status !== 'ACTIVE') {
        throw new Error('CONNECTION_NOT_ACTIVE');
      }
      await manager.query(
        `
          UPDATE ${this.connections}
          SET health = $3,
              state_version = CASE
                WHEN health = $3 THEN state_version
                ELSE state_version + 1
              END,
              updated_at = CASE
                WHEN health = $3 THEN updated_at
                ELSE clock_timestamp()
              END
          WHERE tenant_id = $1 AND id = $2
        `,
        [input.tenantId, input.connectionId, input.health],
      );
      await this.appendAudit(
        manager,
        input,
        'connection.health.update',
        input.connectionId,
      );
    });
    return this.requireConnection(input.tenantId, input.connectionId);
  }

  private async lockConnection(
    manager: EntityManager,
    tenantId: string,
    connectionId: string,
  ): Promise<Pick<ConnectionRow, 'state_version' | 'status'>> {
    const rows = (await manager.query(
      `
        SELECT state_version, status
        FROM ${this.connections}
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `,
      [tenantId, connectionId],
    )) as Pick<ConnectionRow, 'state_version' | 'status'>[];
    if (rows[0] === undefined) throw new Error('CONNECTION_NOT_FOUND');
    return rows[0];
  }

  private async requireConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord> {
    const connection = await this.findById(tenantId, connectionId);
    if (connection === undefined) {
      throw new Error('CONNECTION_PERSISTENCE_INCONSISTENT');
    }
    return connection;
  }

  private async findIdempotentResource(
    manager: EntityManager,
    tenantId: string,
    operationScope: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<string | undefined> {
    const rows = (await manager.query(
      `
        SELECT request_fingerprint, resource_id
        FROM ${this.idempotency}
        WHERE tenant_id = $1
          AND operation_scope = $2
          AND idempotency_key = $3
        FOR UPDATE
      `,
      [tenantId, operationScope, idempotencyKey],
    )) as { request_fingerprint: string; resource_id: string | null }[];
    if (rows[0] === undefined) return undefined;
    if (rows[0].request_fingerprint !== requestFingerprint) {
      throw new Error('IDEMPOTENCY_KEY_REUSED');
    }
    if (rows[0].resource_id === null) {
      throw new Error('IDEMPOTENCY_RESOURCE_CONFLICT');
    }
    return rows[0].resource_id;
  }

  private async requireIdempotentResource(
    manager: EntityManager,
    tenantId: string,
    operationScope: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<string> {
    const resourceId = await this.findIdempotentResource(
      manager,
      tenantId,
      operationScope,
      idempotencyKey,
      requestFingerprint,
    );
    if (resourceId === undefined) {
      throw new Error('IDEMPOTENCY_RECORD_INCONSISTENT');
    }
    return resourceId;
  }

  private async insertIdempotency(
    manager: EntityManager,
    tenantId: string,
    operationScope: string,
    idempotencyKey: string,
    requestFingerprint: string,
    connectionId: string,
  ): Promise<void> {
    const inserted = (await manager.query(
      `
        INSERT INTO ${this.idempotency} (
          id, tenant_id, operation_scope, idempotency_key,
          request_fingerprint, status, resource_type, resource_id,
          completed_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, 'COMPLETED',
          'CONNECTION', $6, clock_timestamp(), clock_timestamp() + interval '90 days'
        )
        ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO NOTHING
        RETURNING id
      `,
      [
        randomUUID(),
        tenantId,
        operationScope,
        idempotencyKey,
        requestFingerprint,
        connectionId,
      ],
    )) as { id: string }[];
    if (inserted.length > 0) return;
    const resourceId = await this.requireIdempotentResource(
      manager,
      tenantId,
      operationScope,
      idempotencyKey,
      requestFingerprint,
    );
    if (resourceId !== connectionId) {
      throw new Error('IDEMPOTENCY_RESOURCE_CONFLICT');
    }
  }

  private async appendAudit(
    manager: EntityManager,
    input:
      | CreateConnectionInput
      | RevokeConnectionInput
      | UpdateConnectionInput
      | {
          readonly actor: ConnectionActor;
          readonly causationId: string;
          readonly correlationId: string;
          readonly tenantId: string;
        },
    action: string,
    connectionId: string,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO ${this.auditEvents} (
          id,
          tenant_id,
          actor_type,
          actor_id,
          action,
          resource_type,
          resource_id,
          outcome,
          correlation_id,
          causation_id
        ) VALUES ($1, $2, $3, $4, $5, 'CONNECTION', $6, 'SUCCEEDED', $7, $8)
      `,
      [
        randomUUID(),
        input.tenantId,
        input.actor.type,
        input.actor.id,
        action,
        connectionId,
        input.correlationId,
        input.causationId,
      ],
    );
  }
}
