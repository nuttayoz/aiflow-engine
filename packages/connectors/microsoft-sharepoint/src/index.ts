import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { connectorCapabilityHash } from '@aiflow/connector-sdk';

export * from './client-state';
export * from './fake-graph';
export * from './graph-port';
export * from './notification';

export interface SharePointEntryConfiguration extends Readonly<
  Record<string, unknown>
> {
  readonly driveId: string;
  readonly folderId: string;
  readonly includeSubfolders: boolean;
  readonly siteId: string;
}

const configurationKeys = [
  'driveId',
  'folderId',
  'includeSubfolders',
  'siteId',
] as const;

const isOpaqueResourceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

export const isSharePointEntryConfiguration = (
  value: unknown,
): value is SharePointEntryConfiguration => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const configuration = value as Record<string, unknown>;
  return (
    Object.keys(configuration).every((key) =>
      configurationKeys.includes(key as never),
    ) &&
    configurationKeys.every((key) => key in configuration) &&
    isOpaqueResourceId(configuration.siteId) &&
    isOpaqueResourceId(configuration.driveId) &&
    isOpaqueResourceId(configuration.folderId) &&
    typeof configuration.includeSubfolders === 'boolean'
  );
};

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
