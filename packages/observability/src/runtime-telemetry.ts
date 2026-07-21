import { createServer, type Server } from 'node:http';

import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

import {
  ConfigurationError,
  type NodeEnvironment,
  type ObservabilityRuntimeConfig,
} from '@aiflow/config';
import { SERVICE_NAME, type RuntimeProcess } from '@aiflow/core';

type MessageOutcome = 'CLAIMED' | 'DUPLICATE' | 'ERROR' | 'STALE';
type SchedulerOutcome = 'ERROR' | 'SUCCESS';

const safeTelemetryError = (error: unknown): Error => {
  if (error instanceof ConfigurationError) {
    return new ConfigurationError(error.message);
  }
  const safe = new Error('Runtime operation failed');
  safe.name = error instanceof Error ? error.name : 'UnknownError';
  return safe;
};

export class RuntimeTelemetry {
  private readonly messages: Counter<'outcome' | 'role' | 'type'>;
  private readonly outbox: Counter<'outcome' | 'role'>;
  private readonly registry = new Registry();
  private readonly scheduler: Counter<'job' | 'outcome' | 'role'>;
  private server?: Server;

  constructor(
    private readonly config: ObservabilityRuntimeConfig,
    environment: NodeEnvironment,
    private readonly role: RuntimeProcess,
  ) {
    this.registry.setDefaultLabels({ service: SERVICE_NAME });
    collectDefaultMetrics({
      prefix: 'aiflow_engine_',
      register: this.registry,
    });
    this.messages = new Counter({
      help: 'Handled AiFlow command messages.',
      labelNames: ['role', 'type', 'outcome'],
      name: 'aiflow_engine_messages_handled_total',
      registers: [this.registry],
    });
    this.outbox = new Counter({
      help: 'AiFlow outbox publication outcomes.',
      labelNames: ['role', 'outcome'],
      name: 'aiflow_engine_outbox_messages_total',
      registers: [this.registry],
    });
    this.scheduler = new Counter({
      help: 'AiFlow scheduler iteration outcomes.',
      labelNames: ['role', 'job', 'outcome'],
      name: 'aiflow_engine_scheduler_iterations_total',
      registers: [this.registry],
    });

    if (config.sentryDsn !== undefined) {
      Sentry.init({
        dsn: config.sentryDsn,
        environment,
        sendDefaultPii: false,
        tracesSampleRate: 0,
      });
      Sentry.setTag('service', SERVICE_NAME);
      Sentry.setTag('runtime_role', role);
    }
  }

  async start(): Promise<void> {
    if (!this.config.metricsEnabled || this.server !== undefined) {
      return;
    }
    this.server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      void this.registry.metrics().then((body) => {
        response.writeHead(200, {
          'content-type': this.registry.contentType,
        });
        response.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(
        this.config.metricsPort,
        this.config.metricsHost,
        () => resolve(),
      );
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  recordMessage(type: string, outcome: MessageOutcome): void {
    this.messages.inc({ outcome, role: this.role, type });
  }

  recordOutbox(published: number, failed: number): void {
    if (published > 0) {
      this.outbox.inc({ outcome: 'published', role: this.role }, published);
    }
    if (failed > 0) {
      this.outbox.inc({ outcome: 'failed', role: this.role }, failed);
    }
  }

  recordScheduler(job: string, outcome: SchedulerOutcome): void {
    this.scheduler.inc({ job, outcome, role: this.role });
  }

  captureException(error: unknown, operation: string): void {
    if (this.config.sentryDsn !== undefined) {
      Sentry.captureException(safeTelemetryError(error), {
        tags: { operation },
      });
    }
  }

  async span<T>(
    name: string,
    operation: () => Promise<T>,
    attributes?: Attributes,
  ): Promise<T> {
    return trace
      .getTracer(SERVICE_NAME)
      .startActiveSpan(name, { attributes }, async (span) => {
        try {
          return await operation();
        } catch (error) {
          span.recordException(safeTelemetryError(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
  }

  async close(): Promise<void> {
    if (this.server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
      this.server = undefined;
    }
    if (this.config.sentryDsn !== undefined) {
      await Sentry.flush(2_000);
    }
  }
}
