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

export interface CreateConnectionInput {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configurationSchemaVersion: number;
  readonly connectorId: string;
  readonly displayName: string;
  readonly id: string;
  readonly secretReference?: string;
  readonly tenantId: string;
}

export interface ConnectionRepository {
  create(input: CreateConnectionInput): Promise<ConnectionRecord>;
  findById(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | undefined>;
}
