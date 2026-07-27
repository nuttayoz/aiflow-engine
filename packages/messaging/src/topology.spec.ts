import { connectorQueueBinding } from './topology';

describe('connector queue topology', () => {
  it('keeps SharePoint metadata sync separate from document ingestion', () => {
    expect(connectorQueueBinding('microsoft-sharepoint', 'sync')).toEqual({
      bindingKeys: [
        'connector.microsoft-sharepoint.watch.reconcile.requested.v1',
      ],
      name: 'aiflow.q.connector.microsoft-sharepoint.sync.v1',
    });
    expect(connectorQueueBinding('microsoft-sharepoint', 'ingest')).toEqual({
      bindingKeys: [
        'document.ingest.connector.microsoft-sharepoint.requested.v1',
      ],
      name: 'aiflow.q.connector.microsoft-sharepoint.ingest.v1',
    });
  });
});
