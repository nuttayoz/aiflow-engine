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
      connectorId: 'direct-upload',
      displayName: 'Direct upload',
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
});
