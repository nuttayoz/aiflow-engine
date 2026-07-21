import type { ConnectorAdapter } from '@aiflow/connector-sdk';

import { runConnectorContractChecks } from './index';

const validConnector: ConnectorAdapter = {
  descriptor: {
    actions: [
      {
        actionId: 'receive',
        capability: 'ENTRY',
        configurationSchema: {
          additionalProperties: false,
          properties: {},
          type: 'object',
        },
        configurationSchemaVersion: 1,
        displayName: 'Receive',
        provisioningMode: 'NONE',
        version: 1,
      },
    ],
    connectorId: 'contract-test',
    displayName: 'Contract test',
    version: 1,
  },
  validateActivation: async () => ({
    capabilityHash: 'hash',
    status: 'READY',
  }),
};

describe('connector contract test suite', () => {
  it('accepts a bounded connector and reports unsafe schemas', () => {
    expect(runConnectorContractChecks(validConnector)).toEqual([]);
    expect(
      runConnectorContractChecks({
        ...validConnector,
        descriptor: {
          ...validConnector.descriptor,
          actions: [
            {
              ...validConnector.descriptor.actions[0],
              configurationSchema: { type: 'object' },
            },
          ],
        },
      }),
    ).toContainEqual({
      code: 'SCHEMA_MUST_REJECT_UNKNOWN_FIELDS',
      path: 'receive',
    });
  });
});
