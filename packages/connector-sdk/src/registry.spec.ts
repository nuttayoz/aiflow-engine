import type { ConnectorAdapter } from './types';
import { ConnectorRegistry, connectorCapabilityHash } from './registry';

const connector: ConnectorAdapter = {
  descriptor: {
    actions: [
      {
        actionId: 'watch-folder',
        capability: 'ENTRY',
        configurationSchema: {
          additionalProperties: false,
          properties: { folderId: { minLength: 1, type: 'string' } },
          required: ['folderId'],
          type: 'object',
        },
        configurationSchemaVersion: 1,
        displayName: 'Watch folder',
        provisioningMode: 'MANAGED',
        version: 1,
      },
    ],
    connectorId: 'test-connector',
    displayName: 'Test connector',
    version: 1,
  },
  validateActivation: async () => ({
    capabilityHash: 'hash',
    status: 'READY',
  }),
};

describe('ConnectorRegistry', () => {
  it('validates connector-owned configuration schemas', () => {
    const registry = new ConnectorRegistry([connector]);

    expect(
      registry.validateConfiguration('test-connector', 'watch-folder', {
        folderId: 'folder-1',
      }),
    ).toEqual({ valid: true });
    expect(
      registry.validateConfiguration('test-connector', 'watch-folder', {}),
    ).toMatchObject({ valid: false });
  });

  it('produces a stable capability hash', () => {
    expect(connectorCapabilityHash(connector.descriptor)).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(connectorCapabilityHash(connector.descriptor)).toBe(
      connectorCapabilityHash({ ...connector.descriptor }),
    );
  });

  it('rejects duplicate connectors and secret-shaped schemas', () => {
    expect(() => new ConnectorRegistry([connector, connector])).toThrow(
      'CONNECTOR_DUPLICATE',
    );
    expect(
      () =>
        new ConnectorRegistry([
          {
            ...connector,
            descriptor: {
              ...connector.descriptor,
              actions: [
                {
                  ...connector.descriptor.actions[0],
                  configurationSchema: {
                    properties: { secretToken: { type: 'string' } },
                    type: 'object',
                  },
                },
              ],
              connectorId: 'unsafe-connector',
            },
          },
        ]),
    ).toThrow('CONNECTOR_SCHEMA_FORBIDDEN_FIELD');
  });
});
