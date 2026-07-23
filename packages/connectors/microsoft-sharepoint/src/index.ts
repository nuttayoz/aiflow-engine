import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { connectorCapabilityHash } from '@aiflow/connector-sdk';

import { isSharePointEntryConfiguration } from './configuration';

export * from './client-state';
export * from './configuration';
export * from './fake-graph';
export * from './graph-port';
export * from './notification';
export * from './provisioning';
export * from './protection';

export const microsoftSharePointDescriptor = {
  actions: [
    {
      actionId: 'watch-folder',
      capability: 'ENTRY',
      connectionRequired: true,
      configurationSchema: {
        additionalProperties: false,
        properties: {
          driveId: { maxLength: 512, minLength: 1, type: 'string' },
          folderId: { maxLength: 512, minLength: 1, type: 'string' },
          includeSubfolders: { type: 'boolean' },
          siteId: { maxLength: 512, minLength: 1, type: 'string' },
        },
        required: ['siteId', 'driveId', 'folderId', 'includeSubfolders'],
        type: 'object',
      },
      configurationSchemaVersion: 1,
      displayName: 'Watch SharePoint folder',
      provisioningMode: 'MANAGED',
      version: 1,
    },
  ],
  connectorId: 'microsoft-sharepoint',
  displayName: 'Microsoft SharePoint',
  version: 1,
} as const;

export const microsoftSharePointConnector: ConnectorAdapter = {
  descriptor: microsoftSharePointDescriptor,
  validateActivation: async ({ configuration, connectionId }) => {
    if (
      connectionId === undefined ||
      !isSharePointEntryConfiguration(configuration)
    ) {
      throw new Error('SHAREPOINT_ENTRY_CONFIGURATION_INVALID');
    }
    return {
      capabilityHash: connectorCapabilityHash(microsoftSharePointDescriptor),
      status: 'READY',
    };
  },
};
