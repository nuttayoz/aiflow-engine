import { randomUUID } from 'node:crypto';

import Ajv, { type ErrorObject, type JSONSchemaType } from 'ajv';
import addFormats from 'ajv-formats';

import type { ActorIdentity } from '@aiflow/core';
import type { ExecutionStage } from '@aiflow/executions';

export const MAX_MESSAGE_BYTES = 64 * 1024;

export type CoreCommandType =
  | 'aiflow.execution.stage.extract.requested.v1'
  | 'aiflow.execution.stage.map.requested.v1'
  | 'aiflow.execution.stage.reconcile.requested.v1'
  | 'aiflow.execution.stage.review.requested.v1'
  | 'aiflow.storage.object.delete.requested.v1'
  | 'aiflow.storage.object.reconcile.requested.v1'
  | 'aiflow.workflow.provisioning.requested.v1';

export type ConnectorCommandType =
  | `aiflow.connector.${string}.watch.reconcile.requested.v1`
  | `aiflow.document.ingest.connector.${string}.requested.v1`
  | `aiflow.execution.stage.deliver.connector.${string}.requested.v1`;

export type MessageType = CoreCommandType | ConnectorCommandType;

export interface MessageTrace {
  readonly traceparent: string;
  readonly tracestate?: string;
}

export interface MessageEnvelope<
  TData extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly data: TData;
  readonly kind: 'COMMAND' | 'EVENT';
  readonly messageId: string;
  readonly occurredAt: string;
  readonly projectId: string;
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly trace?: MessageTrace;
  readonly type: MessageType;
}

export interface StageCommandData extends Readonly<Record<string, unknown>> {
  readonly executionId: string;
  readonly expectedStateVersion: number;
  readonly stage: ExecutionStage;
}

export interface CreateMessageEnvelopeInput<
  TData extends Readonly<Record<string, unknown>>,
> {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly data: TData;
  readonly messageId?: string;
  readonly occurredAt?: Date;
  readonly projectId: string;
  readonly tenantId: string;
  readonly trace?: MessageTrace;
  readonly type: MessageType;
}

interface MutableMessageEnvelope {
  actor: { id: string; type: 'SERVICE' | 'SYSTEM' | 'USER' };
  causationId: string;
  correlationId: string;
  data: Record<string, unknown>;
  kind: 'COMMAND' | 'EVENT';
  messageId: string;
  occurredAt: string;
  projectId: string;
  schemaVersion: 1;
  tenantId: string;
  trace?: { traceparent: string; tracestate?: string };
  type: string;
}

const opaqueId = {
  maxLength: 180,
  minLength: 1,
  type: 'string',
} as const;

const envelopeSchema: JSONSchemaType<MutableMessageEnvelope> = {
  additionalProperties: false,
  properties: {
    actor: {
      additionalProperties: false,
      properties: {
        id: opaqueId,
        type: { enum: ['USER', 'SERVICE', 'SYSTEM'], type: 'string' },
      },
      required: ['id', 'type'],
      type: 'object',
    },
    causationId: opaqueId,
    correlationId: opaqueId,
    data: { additionalProperties: true, required: [], type: 'object' },
    kind: { enum: ['COMMAND', 'EVENT'], type: 'string' },
    messageId: opaqueId,
    occurredAt: { format: 'date-time', type: 'string' },
    projectId: opaqueId,
    schemaVersion: { const: 1, type: 'number' },
    tenantId: opaqueId,
    trace: {
      additionalProperties: false,
      nullable: true,
      properties: {
        traceparent: { maxLength: 128, minLength: 1, type: 'string' },
        tracestate: { maxLength: 512, nullable: true, type: 'string' },
      },
      required: ['traceparent'],
      type: 'object',
    },
    type: {
      maxLength: 180,
      pattern: '^aiflow\\.[a-z0-9]+(?:\\.[a-z0-9-]+)*\\.v[1-9][0-9]*$',
      type: 'string',
    },
  },
  required: [
    'schemaVersion',
    'messageId',
    'kind',
    'type',
    'occurredAt',
    'tenantId',
    'projectId',
    'correlationId',
    'causationId',
    'actor',
    'data',
  ],
  type: 'object',
};

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateEnvelopeSchema = ajv.compile(envelopeSchema);

const forbiddenKey =
  /(?:authorization|body|bytes|content|credential|document|jwt|password|payload|presigned|secret|token|url)/iu;

const hasForbiddenKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenKey(item));
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }

  return Object.entries(value).some(
    ([key, child]) => forbiddenKey.test(key) || hasForbiddenKey(child),
  );
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 180;

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isStateVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const validateData = (envelope: MutableMessageEnvelope): boolean => {
  const { data, type } = envelope;

  if (type.startsWith('aiflow.execution.stage.')) {
    const common =
      isNonEmptyString(data.executionId) &&
      isStateVersion(data.expectedStateVersion) &&
      ['EXTRACT', 'MAP', 'REVIEW', 'DELIVER'].includes(String(data.stage));

    if (type.includes('.deliver.connector.')) {
      return (
        common &&
        isNonEmptyString(data.connectorId) &&
        data.stage === 'DELIVER' &&
        hasOnlyKeys(data, [
          'executionId',
          'stage',
          'connectorId',
          'expectedStateVersion',
        ])
      );
    }

    return (
      common &&
      hasOnlyKeys(data, ['executionId', 'stage', 'expectedStateVersion'])
    );
  }

  if (type.startsWith('aiflow.document.ingest.connector.')) {
    return (
      isNonEmptyString(data.ingestionId) &&
      isNonEmptyString(data.connectorId) &&
      isStateVersion(data.expectedStateVersion) &&
      hasOnlyKeys(data, ['ingestionId', 'connectorId', 'expectedStateVersion'])
    );
  }

  if (type.startsWith('aiflow.connector.') && type.includes('.watch.')) {
    return (
      isNonEmptyString(data.watchId) &&
      isStateVersion(data.expectedStateVersion) &&
      isStateVersion(data.expectedNotificationGeneration) &&
      hasOnlyKeys(data, [
        'watchId',
        'expectedStateVersion',
        'expectedNotificationGeneration',
      ])
    );
  }

  if (type.startsWith('aiflow.storage.object.')) {
    return (
      isNonEmptyString(data.storageObjectId) &&
      isStateVersion(data.expectedStateVersion) &&
      hasOnlyKeys(data, ['storageObjectId', 'expectedStateVersion'])
    );
  }

  if (type === 'aiflow.workflow.provisioning.requested.v1') {
    return (
      isNonEmptyString(data.provisioningOperationId) &&
      isStateVersion(data.expectedStateVersion) &&
      hasOnlyKeys(data, ['provisioningOperationId', 'expectedStateVersion'])
    );
  }

  return false;
};

export type MessageValidationResult =
  | { readonly envelope: MessageEnvelope; readonly valid: true }
  | {
      readonly code:
        | 'MESSAGE_DATA_INVALID'
        | 'MESSAGE_ENVELOPE_INVALID'
        | 'MESSAGE_FORBIDDEN_FIELD'
        | 'MESSAGE_INVALID_JSON'
        | 'MESSAGE_TOO_LARGE';
      readonly errors?: readonly ErrorObject[];
      readonly valid: false;
    };

export const validateMessageEnvelope = (
  bytes: Buffer,
): MessageValidationResult => {
  if (bytes.byteLength > MAX_MESSAGE_BYTES) {
    return { code: 'MESSAGE_TOO_LARGE', valid: false };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return { code: 'MESSAGE_INVALID_JSON', valid: false };
  }

  if (!validateEnvelopeSchema(decoded)) {
    return {
      code: 'MESSAGE_ENVELOPE_INVALID',
      errors: validateEnvelopeSchema.errors ?? undefined,
      valid: false,
    };
  }
  if (hasForbiddenKey(decoded.data)) {
    return { code: 'MESSAGE_FORBIDDEN_FIELD', valid: false };
  }
  if (!validateData(decoded)) {
    return { code: 'MESSAGE_DATA_INVALID', valid: false };
  }

  return { envelope: decoded as MessageEnvelope, valid: true };
};

export const encodeMessageEnvelope = (envelope: MessageEnvelope): Buffer => {
  const encoded = Buffer.from(JSON.stringify(envelope));
  const validation = validateMessageEnvelope(encoded);

  if (!validation.valid) {
    throw new Error(validation.code);
  }

  return encoded;
};

export const createMessageEnvelope = <
  TData extends Readonly<Record<string, unknown>>,
>(
  input: CreateMessageEnvelopeInput<TData>,
): MessageEnvelope<TData> => ({
  actor: input.actor,
  causationId: input.causationId,
  correlationId: input.correlationId,
  data: input.data,
  kind: 'COMMAND',
  messageId: input.messageId ?? randomUUID(),
  occurredAt: (input.occurredAt ?? new Date()).toISOString(),
  projectId: input.projectId,
  schemaVersion: 1,
  tenantId: input.tenantId,
  ...(input.trace === undefined ? {} : { trace: input.trace }),
  type: input.type,
});

export const routingKeyForMessageType = (type: MessageType): string =>
  type.replace(/^aiflow\./u, '');
