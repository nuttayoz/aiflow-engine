import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { connectorCapabilityHash } from '@aiflow/connector-sdk';

const descriptor = {
  actions: [
    {
      actionId: 'receive',
      capability: 'ENTRY',
      connectionRequired: false,
      configurationSchema: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
      configurationSchemaVersion: 1,
      displayName: 'Direct upload',
      provisioningMode: 'NONE',
      version: 1,
    },
  ],
  connectorId: 'direct-upload',
  displayName: 'Direct upload',
  version: 1,
} as const;

export const directUploadConnector: ConnectorAdapter = {
  descriptor,
  validateActivation: async () => ({
    capabilityHash: connectorCapabilityHash(descriptor),
    status: 'READY',
  }),
};
