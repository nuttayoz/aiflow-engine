import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import {
  DatabaseService,
  PostgresExecutionRecoveryRepository,
  PostgresOutboxRepository,
  PostgresSchedulerLeaseRepository,
} from '@aiflow/database';
import {
  OutboxPublisher,
  RABBIT_MQ_CLIENT,
  type RabbitMqClient,
} from '@aiflow/messaging';
import { RuntimeTelemetry } from '@aiflow/observability';

@Injectable()
export class FoundationSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly abort = new AbortController();
  private readonly logger = new Logger(FoundationSchedulerService.name);
  private readonly owner = `${hostname()}:${process.pid.toString()}:${randomUUID()}`;
  private loops: readonly Promise<void>[] = [];

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RABBIT_MQ_CLIENT) private readonly rabbitMq: RabbitMqClient,
    @Inject(RuntimeTelemetry) private readonly telemetry: RuntimeTelemetry,
  ) {}

  onApplicationBootstrap(): void {
    const schema = this.database.schema;
    const outbox = new OutboxPublisher(
      new PostgresOutboxRepository(this.database.dataSource, schema),
      this.rabbitMq,
    );
    const leases = new PostgresSchedulerLeaseRepository(
      this.database.dataSource,
      schema,
    );
    const recovery = new PostgresExecutionRecoveryRepository(
      this.database.dataSource,
      schema,
    );

    this.loops = [
      this.runLoop('outbox', 250, async () => {
        const result = await outbox.publishBatch({
          batchSize: 100,
          leaseDurationMs: 30_000,
          owner: this.owner,
        });
        this.telemetry.recordOutbox(result.published, result.failed);
      }),
      this.runLoop('recovery', 1_000, async () => {
        const lease = await leases.acquire({
          durationMs: 5_000,
          jobName: 'execution-recovery',
          owner: this.owner,
        });
        if (lease === undefined) {
          return;
        }
        await recovery.recoverExpiredLeases(100, 1_000);
        await recovery.enqueueDueRetries(100);
      }),
    ];
  }

  async onApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.loops);
  }

  private async runLoop(
    name: string,
    intervalMs: number,
    task: () => Promise<unknown>,
  ): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await task();
        this.telemetry.recordScheduler(name, 'SUCCESS');
      } catch (error) {
        this.telemetry.recordScheduler(name, 'ERROR');
        this.telemetry.captureException(error, `scheduler.${name}`);
        this.logger.error({ event: 'scheduler.iteration.failed', job: name });
      }
      try {
        await delay(intervalMs, undefined, { signal: this.abort.signal });
      } catch {
        return;
      }
    }
  }
}
