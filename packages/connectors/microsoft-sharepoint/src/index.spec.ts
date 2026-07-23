import { runConnectorContractChecks } from '@aiflow/connector-test-suite';
import { ConnectorRegistry } from '@aiflow/connector-sdk';

import {
  isSharePointEntryConfiguration,
  microsoftSharePointConnector,
} from './index';

const validConfiguration = {
  driveId: 'drive-id',
  folderId: 'folder-id',
  includeSubfolders: true,
  siteId: 'site-id',
};

describe('Microsoft SharePoint connector', () => {
  it('publishes a bounded managed-entry descriptor', () => {
    expect(runConnectorContractChecks(microsoftSharePointConnector)).toEqual(
      [],
    );
    expect(microsoftSharePointConnector.descriptor.actions).toContainEqual(
      expect.objectContaining({
        actionId: 'watch-folder',
        capability: 'ENTRY',
        connectionRequired: true,
        provisioningMode: 'MANAGED',
        version: 1,
      }),
    );
  });

  it('accepts only the exact version-one folder selection', () => {
    const registry = new ConnectorRegistry([microsoftSharePointConnector]);

    expect(
      registry.validateConfiguration(
        'microsoft-sharepoint',
        'watch-folder',
        validConfiguration,
      ),
    ).toEqual({ valid: true });
    expect(isSharePointEntryConfiguration(validConfiguration)).toBe(true);
    expect(
      registry.validateConfiguration('microsoft-sharepoint', 'watch-folder', {
        ...validConfiguration,
        providerUrl: 'https://example.invalid',
      }),
    ).toMatchObject({ valid: false });
    expect(
      isSharePointEntryConfiguration({
        ...validConfiguration,
        includeSubfolders: 'true',
      }),
    ).toBe(false);
  });

  it('requires an owned connection during activation validation', async () => {
    await expect(
      microsoftSharePointConnector.validateActivation({
        actionId: 'watch-folder',
        configuration: validConfiguration,
        projectId: 'project-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow('SHAREPOINT_ENTRY_CONFIGURATION_INVALID');

    await expect(
      microsoftSharePointConnector.validateActivation({
        actionId: 'watch-folder',
        configuration: validConfiguration,
        connectionId: 'connection-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toMatchObject({ status: 'READY' });
  });
});
