export interface ConnectionRecord {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configurationSchemaVersion: number;
  readonly connectorId: string;
  readonly createdAt: Date;
  readonly displayName: string;
  readonly health: 'DEGRADED' | 'HEALTHY' | 'UNKNOWN';
  readonly id: string;
  readonly stateVersion: number;
  readonly status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface ConnectionActor {
  readonly id: string;
  readonly type: 'SERVICE' | 'SYSTEM' | 'USER';
}

export interface CreateConnectionInput {
  readonly actor: ConnectionActor;
  readonly causationId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configurationSchemaVersion: number;
  readonly connectorId: string;
  readonly correlationId: string;
  readonly displayName: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly secretReference?: string;
  readonly tenantId: string;
}

export interface UpdateConnectionInput {
  readonly actor: ConnectionActor;
  readonly causationId: string;
  readonly connectionId: string;
  readonly correlationId: string;
  readonly displayName: string;
  readonly expectedStateVersion: number;
  readonly idempotencyKey: string;
  readonly tenantId: string;
}

export interface RevokeConnectionInput {
  readonly actor: ConnectionActor;
  readonly causationId: string;
  readonly connectionId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly tenantId: string;
}

export interface ConnectionRepository {
  create(input: CreateConnectionInput): Promise<ConnectionRecord>;
  findById(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | undefined>;
  list(
    tenantId: string,
    connectorId?: string,
  ): Promise<readonly ConnectionRecord[]>;
  revoke(input: RevokeConnectionInput): Promise<ConnectionRecord>;
  update(input: UpdateConnectionInput): Promise<ConnectionRecord>;
}
