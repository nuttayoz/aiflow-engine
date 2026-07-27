import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { connectorCapabilityHash } from '@aiflow/connector-sdk';

import { isSharePointEntryConfiguration } from './configuration';

export * from './client-state';
export * from './configuration';
export * from './entra';
export * from './fake-graph';
export * from './graph-port';
export * from './http-graph';
export * from './ingestion';
export * from './notification';
export * from './provisioning';
export * from './protection';
export * from './resources';
export * from './sync';

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
  connectionConfigurationSchema: {
    additionalProperties: false,
    properties: {
      externalTenantId: {
        maxLength: 36,
        minLength: 36,
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
        type: 'string',
      },
      identityMode: { const: 'SAAS_MULTITENANT', type: 'string' },
      permissionProfile: {
        const: 'FILES_AND_SITES_READ_ALL_V1',
        type: 'string',
      },
    },
    required: ['externalTenantId', 'identityMode', 'permissionProfile'],
    type: 'object',
  },
  connectionConfigurationSchemaVersion: 1,
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
