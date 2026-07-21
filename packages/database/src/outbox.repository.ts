import { randomUUID } from 'node:crypto';

import type { DataSource, QueryRunner } from 'typeorm';

import type {
  MessageEnvelope,
  OutboxClaimOptions,
  OutboxMessageRecord,
  OutboxRepository,
} from '@aiflow/messaging';

import { mutationRows, table } from './sql';

interface OutboxRow {
  aggregate_id: string;
  aggregate_type: string;
  available_at: Date | string;
  envelope: MessageEnvelope | string;
  id: string;
  message_id: string;
  publish_attempt_count: number | string;
  publish_lease_owner: string | null;
}

const asEnvelope = (value: MessageEnvelope | string): MessageEnvelope =>
  typeof value === 'string' ? (JSON.parse(value) as MessageEnvelope) : value;

const mapRow = (row: OutboxRow): OutboxMessageRecord => ({
  aggregateId: row.aggregate_id,
  aggregateType: row.aggregate_type,
  availableAt: new Date(row.available_at),
  envelope: asEnvelope(row.envelope),
  id: row.id,
  messageId: row.message_id,
  publishAttemptCount: Number(row.publish_attempt_count),
  ...(row.publish_lease_owner === null
    ? {}
    : { publishLeaseOwner: row.publish_lease_owner }),
});

export interface AppendOutboxInput {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly availableAt?: Date;
  readonly envelope: MessageEnvelope;
}

export class PostgresOutboxRepository implements OutboxRepository {
  private readonly outboxTable: string;

  constructor(
    private readonly dataSource: DataSource,
    schema: string,
  ) {
    this.outboxTable = table(schema, 'outbox_messages');
  }

  async append(
    queryRunner: QueryRunner,
    input: AppendOutboxInput,
  ): Promise<void> {
    await queryRunner.query(
      `
        INSERT INTO ${this.outboxTable} (
          id,
          message_id,
          message_type,
          tenant_id,
          project_id,
          aggregate_type,
          aggregate_id,
          envelope,
          available_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      `,
      [
        randomUUID(),
        input.envelope.messageId,
        input.envelope.type,
        input.envelope.tenantId,
        input.envelope.projectId,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.envelope),
        input.availableAt ?? new Date(),
      ],
    );
  }

  async claim(
    options: OutboxClaimOptions,
  ): Promise<readonly OutboxMessageRecord[]> {
    if (
      !Number.isInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 500 ||
      !Number.isInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 1_000 ||
      options.leaseDurationMs > 300_000 ||
      options.owner.length === 0 ||
      options.owner.length > 180
    ) {
      throw new Error('OUTBOX_CLAIM_OPTIONS_INVALID');
    }

    return this.dataSource.transaction(async (manager) => {
      const rows = mutationRows<OutboxRow>(
        await manager.query(
          `
          WITH candidates AS (
            SELECT id
            FROM ${this.outboxTable}
            WHERE published_at IS NULL
              AND available_at <= clock_timestamp()
              AND (
                publish_lease_expires_at IS NULL
                OR publish_lease_expires_at <= clock_timestamp()
              )
            ORDER BY available_at, id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE ${this.outboxTable} AS outbox
          SET publish_lease_owner = $2,
              publish_lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
              publish_attempt_count = publish_attempt_count + 1,
              last_error_code = NULL
          FROM candidates
          WHERE outbox.id = candidates.id
          RETURNING
            outbox.id,
            outbox.message_id,
            outbox.aggregate_type,
            outbox.aggregate_id,
            outbox.envelope,
            outbox.available_at,
            outbox.publish_attempt_count,
            outbox.publish_lease_owner
        `,
          [options.batchSize, options.owner, options.leaseDurationMs],
        ),
      );

      return rows.map(mapRow);
    });
  }

  async markPublished(id: string, owner: string): Promise<boolean> {
    const rows = mutationRows<{ id: string }>(
      await this.dataSource.query(
        `
        UPDATE ${this.outboxTable}
        SET published_at = clock_timestamp(),
            publish_lease_owner = NULL,
            publish_lease_expires_at = NULL,
            last_error_code = NULL
        WHERE id = $1
          AND publish_lease_owner = $2
          AND published_at IS NULL
        RETURNING id
      `,
        [id, owner],
      ),
    );

    return rows.length === 1;
  }

  async release(
    id: string,
    owner: string,
    safeErrorCode: string,
  ): Promise<boolean> {
    if (safeErrorCode.length === 0 || safeErrorCode.length > 180) {
      throw new Error('OUTBOX_ERROR_CODE_INVALID');
    }

    const rows = mutationRows<{ id: string }>(
      await this.dataSource.query(
        `
        UPDATE ${this.outboxTable}
        SET publish_lease_owner = NULL,
            publish_lease_expires_at = NULL,
            last_error_code = $3
        WHERE id = $1
          AND publish_lease_owner = $2
          AND published_at IS NULL
        RETURNING id
      `,
        [id, owner, safeErrorCode],
      ),
    );

    return rows.length === 1;
  }
}
