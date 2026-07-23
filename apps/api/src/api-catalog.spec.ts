import { ApiService } from './api.service';

const createService = (): ApiService =>
  new ApiService(undefined as never, undefined as never);

describe('API catalogs', () => {
  it('lists installed connectors and filters by capability', () => {
    const service = createService();

    expect(
      service.connectorCatalog().map(({ connectorId }) => connectorId),
    ).toEqual(['direct-upload', 'microsoft-business-central']);
    expect(
      service.connectorCatalog('ENTRY').map(({ connectorId }) => connectorId),
    ).toEqual(['direct-upload']);
    expect(
      service
        .connectorCatalog('DESTINATION')
        .map(({ connectorId }) => connectorId),
    ).toEqual(['microsoft-business-central']);
    expect(() => service.connectorCatalog('entry')).toThrow(
      'CONNECTOR_CAPABILITY_INVALID',
    );
  });

  it('returns connector detail and a stable not-found error', () => {
    const service = createService();

    expect(service.connectorDescriptor('direct-upload')).toMatchObject({
      actions: [expect.objectContaining({ connectionRequired: false })],
      connectorId: 'direct-upload',
      displayName: 'Direct upload',
    });
    expect(
      service.connectorDescriptor('microsoft-business-central'),
    ).toMatchObject({
      actions: [expect.objectContaining({ connectionRequired: true })],
    });
    expect(() => service.connectorDescriptor('missing')).toThrow(
      'CONNECTOR_NOT_FOUND',
    );
  });

  it('returns extraction profile list and detail projections', () => {
    const service = createService();

    expect(service.extractionProfileCatalog()).toEqual([
      expect.objectContaining({
        displayName: 'Basic invoice',
        profileId: 'invoice-basic',
      }),
    ]);
    expect(service.extractionProfileDescriptor('invoice-basic')).toMatchObject({
      outputFields: expect.arrayContaining(['invoice_number']),
      profileVersionId: 'invoice-basic-v1',
    });
    expect(() => service.extractionProfileDescriptor('missing')).toThrow(
      'EXTRACTION_PROFILE_NOT_FOUND',
    );
  });

  it('rejects connection shells for unsupported connectors and secret-shaped input', async () => {
    const service = createService();
    const authorization = {
      actor: { id: 'user-1', type: 'USER' as const },
      correlationId: 'correlation-1',
      projectId: 'project-1',
      tenantId: 'tenant-1',
    };

    await expect(
      service.createConnection(
        authorization,
        {
          configuration: {},
          connectorId: 'direct-upload',
          displayName: 'Invalid connection',
        },
        'connection-1',
      ),
    ).rejects.toThrow('CONNECTION_CONNECTOR_NOT_SUPPORTED');
    await expect(
      service.createConnection(
        authorization,
        {
          configuration: {},
          connectorId: 'microsoft-business-central',
          displayName: 'Unsafe connection',
          password: 'must-not-be-accepted',
        },
        'connection-2',
      ),
    ).rejects.toThrow('CONNECTION_INPUT_INVALID');
  });
});
