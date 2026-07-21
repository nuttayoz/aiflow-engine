import { runConnectorContractChecks } from '@aiflow/connector-test-suite';

import { directUploadConnector } from './index';

describe('direct-upload connector', () => {
  it('passes the shared connector contract', async () => {
    expect(runConnectorContractChecks(directUploadConnector)).toEqual([]);
    await expect(
      directUploadConnector.validateActivation({
        actionId: 'receive',
        configuration: {},
        projectId: 'project-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toMatchObject({ status: 'READY' });
  });
});
