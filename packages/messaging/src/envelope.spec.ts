import {
  createMessageEnvelope,
  encodeMessageEnvelope,
  MAX_MESSAGE_BYTES,
  routingKeyForMessageType,
  validateMessageEnvelope,
} from './envelope';

const envelope = createMessageEnvelope({
  actor: { id: 'user-1', type: 'USER' },
  causationId: 'request-1',
  correlationId: 'correlation-1',
  data: {
    executionId: 'execution-1',
    expectedStateVersion: 0,
    stage: 'EXTRACT',
  },
  messageId: 'message-1',
  occurredAt: new Date('2026-07-20T00:00:00.000Z'),
  projectId: 'project-1',
  tenantId: 'tenant-1',
  type: 'aiflow.execution.stage.extract.requested.v1',
});

describe('message envelope v1', () => {
  it('round-trips a bounded command and derives its routing key', () => {
    const encoded = encodeMessageEnvelope(envelope);

    expect(validateMessageEnvelope(encoded)).toEqual({
      envelope,
      valid: true,
    });
    expect(routingKeyForMessageType(envelope.type)).toBe(
      'execution.stage.extract.requested.v1',
    );
  });

  it('rejects confidential fields and document content', () => {
    const unsafe = Buffer.from(
      JSON.stringify({
        ...envelope,
        data: { ...envelope.data, authorization: 'Bearer secret' },
      }),
    );

    expect(validateMessageEnvelope(unsafe)).toEqual({
      code: 'MESSAGE_FORBIDDEN_FIELD',
      valid: false,
    });
  });

  it('rejects oversized and unsupported messages', () => {
    expect(
      validateMessageEnvelope(Buffer.alloc(MAX_MESSAGE_BYTES + 1)),
    ).toEqual({ code: 'MESSAGE_TOO_LARGE', valid: false });
    expect(
      validateMessageEnvelope(
        Buffer.from(JSON.stringify({ ...envelope, type: 'aiflow.unknown.v1' })),
      ),
    ).toEqual({ code: 'MESSAGE_DATA_INVALID', valid: false });
  });

  it('accepts a SharePoint watch command with guards only', () => {
    const watchCommand = createMessageEnvelope({
      actor: { id: 'sharepoint-callback', type: 'SERVICE' },
      causationId: 'notification-1',
      correlationId: 'correlation-1',
      data: {
        expectedNotificationGeneration: 3,
        expectedStateVersion: 2,
        watchId: 'watch-1',
      },
      projectId: 'project-1',
      tenantId: 'tenant-1',
      type: 'aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1',
    });

    expect(
      validateMessageEnvelope(encodeMessageEnvelope(watchCommand)),
    ).toEqual({
      envelope: watchCommand,
      valid: true,
    });
    expect(routingKeyForMessageType(watchCommand.type)).toBe(
      'connector.microsoft-sharepoint.watch.reconcile.requested.v1',
    );
  });
});
