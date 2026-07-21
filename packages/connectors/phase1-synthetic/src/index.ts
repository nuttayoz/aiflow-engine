import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { connectorCapabilityHash } from '@aiflow/connector-sdk';

const descriptor = {
  actions: [
    {
      actionId: 'accept',
      capability: 'DESTINATION',
      configurationSchema: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
      configurationSchemaVersion: 1,
      displayName: 'Accept synthetic result',
      provisioningMode: 'NONE',
      version: 1,
    },
  ],
  connectorId: 'phase1-synthetic',
  displayName: 'Phase 1 synthetic destination',
  version: 1,
} as const;

export const phase1SyntheticConnector: ConnectorAdapter = {
  descriptor,
  validateActivation: async () => ({
    capabilityHash: connectorCapabilityHash(descriptor),
    status: 'READY',
  }),
};
