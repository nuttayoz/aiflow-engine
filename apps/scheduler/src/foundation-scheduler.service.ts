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
import type { S3RuntimeConfig } from '@aiflow/config';

import {
  DatabaseService,
  PostgresExecutionRecoveryRepository,
  PostgresOutboxRepository,
  PostgresPipelineRepository,
  PostgresSchedulerLeaseRepository,
  PostgresSharePointRecoveryRepository,
  PostgresUploadSessionRepository,
} from '@aiflow/database';
import {
  OutboxPublisher,
  RABBIT_MQ_CLIENT,
  type RabbitMqClient,
} from '@aiflow/messaging';
import { RuntimeTelemetry } from '@aiflow/observability';
import { S3ObjectStorage } from '@aiflow/storage';

import { SCHEDULER_S3_CONFIG } from './scheduler.tokens';

@Injectable()
export class FoundationSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly abort = new AbortController();
  private readonly logger = new Logger(FoundationSchedulerService.name);
  private readonly owner = `${hostname()}:${process.pid.toString()}:${randomUUID()}`;
  private loops: readonly Promise<void>[] = [];
  private storage?: S3ObjectStorage;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RABBIT_MQ_CLIENT) private readonly rabbitMq: RabbitMqClient,
    @Inject(RuntimeTelemetry) private readonly telemetry: RuntimeTelemetry,
    @Inject(SCHEDULER_S3_CONFIG) private readonly s3Config: S3RuntimeConfig,
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
    const pipeline = new PostgresPipelineRepository(
      this.database.dataSource,
      schema,
    );
    const uploadSessions = new PostgresUploadSessionRepository(
      this.database.dataSource,
      schema,
    );
    const sharePointRecovery = new PostgresSharePointRecoveryRepository(
      this.database.dataSource,
      schema,
    );
    this.storage = new S3ObjectStorage(this.s3Config);

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
        await pipeline.enqueueDueDeliveryReconciliations(100);
      }),
      this.runLoop('upload-expiry', 5_000, async () => {
        const lease = await leases.acquire({
          durationMs: 10_000,
          jobName: 'upload-session-expiry',
          owner: this.owner,
        });
        if (lease === undefined) return;
        const expired = await uploadSessions.listExpiredActive(100);
        for (const session of expired) {
          await uploadSessions.expire({
            actor: { id: this.owner, type: 'SYSTEM' },
            causationId: `upload-expiry:${session.id}`,
            correlationId: `upload-expiry:${session.id}`,
            expectedStateVersion: session.stateVersion,
            tenantId: session.tenantId,
            uploadSessionId: session.id,
          });
          if (session.multipartUploadReference !== undefined) {
            await this.storage?.abortMultipartUpload({
              storageObjectId: session.storageObjectId,
              tenantId: session.tenantId,
              uploadReference: session.multipartUploadReference,
            });
          } else {
            const object = await this.storage?.inspectUpload({
              storageObjectId: session.storageObjectId,
              tenantId: session.tenantId,
            });
            if (object !== undefined) {
              await this.storage?.deleteExactVersion({
                key: object.key,
                versionId: object.versionId,
              });
            }
          }
        }
      }),
      this.runLoop('sharepoint-recovery', 5_000, async () => {
        const lease = await leases.acquire({
          durationMs: 10_000,
          jobName: 'sharepoint-recovery',
          owner: this.owner,
        });
        if (lease === undefined) return;
        await sharePointRecovery.enqueueDueReconciliations(100);
      }),
    ];
  }

  async onApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.loops);
    this.storage?.close();
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
