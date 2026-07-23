import { AiFlowClient, type WorkflowDefinitionV1 } from './index';

const definition: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  destination: {
    actionId: 'create-purchase-invoice-draft',
    config: { companyId: 'company-1' },
    connectionId: 'connection-1',
    connectorId: 'microsoft-business-central',
  },
  entry: { config: {}, connectorId: 'direct-upload' },
  extraction: { config: {}, profileId: 'invoice-basic' },
  mappings: [
    {
      required: true,
      sourceField: 'invoiceNumber',
      targetField: 'vendorInvoiceNumber',
    },
  ],
  reviewPolicy: { required: false },
};

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });

describe('DevPortal canonical API client boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists and reads connector and extraction-profile catalogs', async () => {
    const connector = {
      actions: [],
      connectorId: 'direct-upload',
      displayName: 'Direct upload',
      version: 1,
    };
    const profile = {
      displayName: 'Basic invoice',
      outputFields: ['invoice_number'],
      outputSchemaHash: 'schema-hash',
      profileId: 'invoice-basic',
      profileKind: 'SYSTEM',
      profileVersionId: 'invoice-basic-v1',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([connector]))
      .mockResolvedValueOnce(jsonResponse(connector))
      .mockResolvedValueOnce(jsonResponse([profile]))
      .mockResolvedValueOnce(jsonResponse(profile));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await expect(client.listConnectors('ENTRY')).resolves.toEqual([connector]);
    await expect(client.getConnector('direct-upload')).resolves.toEqual(
      connector,
    );
    await expect(client.listExtractionProfiles()).resolves.toEqual([profile]);
    await expect(client.getExtractionProfile('invoice-basic')).resolves.toEqual(
      profile,
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://engine.example/api/v1/connectors?capability=ENTRY',
      'https://engine.example/api/v1/connectors/direct-upload',
      'https://engine.example/api/v1/extraction-profiles',
      'https://engine.example/api/v1/extraction-profiles/invoice-basic',
    ]);
  });

  it('uses the bearer token and never sends the legacy identity header', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await expect(client.listWorkflows('project-1')).resolves.toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://engine.example/api/v1/projects/project-1/workflows',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.has('x-client-id')).toBe(false);
  });

  it('manages safe connection metadata through canonical paths', async () => {
    const connection = {
      configuration: {},
      configurationSchemaVersion: 1,
      connectorId: 'microsoft-business-central',
      createdAt: '2026-07-23T00:00:00.000Z',
      displayName: 'Finance BC',
      health: 'UNKNOWN',
      id: 'connection-1',
      stateVersion: 0,
      status: 'ACTIVE',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    const renamed = {
      ...connection,
      displayName: 'Finance Business Central',
      stateVersion: 1,
    };
    const revoked = { ...renamed, stateVersion: 2, status: 'REVOKED' };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(connection))
      .mockResolvedValueOnce(jsonResponse([connection]))
      .mockResolvedValueOnce(jsonResponse(connection))
      .mockResolvedValueOnce(jsonResponse(renamed))
      .mockResolvedValueOnce(jsonResponse(revoked));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await client.createConnection({
      connectorId: 'microsoft-business-central',
      displayName: 'Finance BC',
      idempotencyKey: 'create-connection-1',
    });
    await client.listConnections('microsoft-business-central');
    await client.getConnection('connection-1');
    await client.updateConnection({
      connectionId: 'connection-1',
      displayName: 'Finance Business Central',
      expectedStateVersion: 0,
      idempotencyKey: 'rename-connection-1',
    });
    await client.revokeConnection({
      connectionId: 'connection-1',
      idempotencyKey: 'revoke-connection-1',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://engine.example/api/v1/connections',
      'https://engine.example/api/v1/connections?connectorId=microsoft-business-central',
      'https://engine.example/api/v1/connections/connection-1',
      'https://engine.example/api/v1/connections/connection-1',
      'https://engine.example/api/v1/connections/connection-1',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'POST',
      undefined,
      undefined,
      'PATCH',
      'DELETE',
    ]);
    expect(
      new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe('rename-connection-1');
  });

  it('supports same-origin BFF authentication without exposing a browser token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new AiFlowClient('/api/proxy/aiflow-engine');

    await client.listWorkflows('project-1');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      '/api/proxy/aiflow-engine/api/v1/projects/project-1/workflows',
    );
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('submits the canonical definition without legacy workflow fields', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        activeVersionId: null,
        health: 'UNKNOWN',
        id: 'workflow-1',
        latestVersion: { id: 'version-1', versionNumber: 1 },
        name: 'Invoice intake',
        projectId: 'project-1',
        status: 'INACTIVE',
      }),
    );
    const client = new AiFlowClient('https://engine.example/', () => 'token-1');

    await client.createWorkflow({
      definition,
      idempotencyKey: 'create-workflow-1',
      name: 'Invoice intake',
      projectId: 'project-1',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ definition, name: 'Invoice intake' });
    expect(body).not.toHaveProperty('nodes');
    expect(body).not.toHaveProperty('payload_version');
    expect(body).not.toHaveProperty('client_id');
  });

  it('creates and reads immutable workflow versions through canonical paths', async () => {
    const version = {
      createdAt: '2026-07-22T00:00:00.000Z',
      createdBy: { id: 'user-1', type: 'USER' },
      definition,
      definitionHash: 'definition-hash',
      id: 'version-2',
      profileReference: {
        outputSchemaHash: 'schema-hash',
        profileId: 'invoice-basic',
        profileKind: 'SYSTEM',
        profileVersionId: 'invoice-basic-v1',
      },
      schemaVersion: 1,
      status: 'VALID',
      versionNumber: 2,
      workflowId: 'workflow-1',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(version))
      .mockResolvedValueOnce(jsonResponse([version]))
      .mockResolvedValueOnce(jsonResponse(version));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await client.createWorkflowVersion({
      basedOnVersionId: 'version-1',
      definition,
      idempotencyKey: 'edit-workflow-1',
      workflowId: 'workflow-1',
    });
    await client.listWorkflowVersions('workflow-1');
    await client.getWorkflowVersion('workflow-1', 'version-2');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://engine.example/api/v1/workflows/workflow-1/versions',
      'https://engine.example/api/v1/workflows/workflow-1/versions',
      'https://engine.example/api/v1/workflows/workflow-1/versions/version-2',
    ]);
    const createInit = fetchMock.mock.calls[0]?.[1];
    expect(createInit?.method).toBe('POST');
    expect(new Headers(createInit?.headers).get('Idempotency-Key')).toBe(
      'edit-workflow-1',
    );
    expect(JSON.parse(String(createInit?.body))).toEqual({
      basedOnVersionId: 'version-1',
      definition,
    });
  });

  it('reads activation state and deactivates with an idempotency key', async () => {
    const activation = {
      acceptingNewDocuments: true,
      activeVersionId: 'version-2',
      cleanupRequired: false,
      health: 'HEALTHY',
      operation: null,
      targetVersionId: null,
      workflowId: 'workflow-1',
    };
    const deactivated = {
      ...activation,
      acceptingNewDocuments: false,
      activeVersionId: null,
      health: 'UNKNOWN',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(activation))
      .mockResolvedValueOnce(jsonResponse(deactivated));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await expect(client.getWorkflowActivation('workflow-1')).resolves.toEqual(
      activation,
    );
    await expect(
      client.deactivateWorkflow({
        idempotencyKey: 'deactivate-workflow-1',
        workflowId: 'workflow-1',
      }),
    ).resolves.toEqual(deactivated);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://engine.example/api/v1/workflows/workflow-1/activation',
      'https://engine.example/api/v1/workflows/workflow-1/activation',
    ]);
    const deactivate = fetchMock.mock.calls[1]?.[1];
    expect(deactivate?.method).toBe('DELETE');
    expect(new Headers(deactivate?.headers).get('Idempotency-Key')).toBe(
      'deactivate-workflow-1',
    );
  });

  it('archives a workflow without using legacy delete payloads', async () => {
    const archived = {
      acceptingNewDocuments: false,
      activeVersionId: null,
      cleanupRequired: false,
      health: 'UNKNOWN',
      id: 'workflow-1',
      latestVersion: {
        definition,
        id: 'version-2',
        versionNumber: 2,
      },
      name: 'Invoice intake',
      projectId: 'project-1',
      status: 'ARCHIVED',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(archived));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await expect(
      client.archiveWorkflow({
        idempotencyKey: 'archive-workflow-1',
        workflowId: 'workflow-1',
      }),
    ).resolves.toEqual(archived);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://engine.example/api/v1/workflows/workflow-1');
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      'archive-workflow-1',
    );
    expect(init?.body).toBeUndefined();
  });

  it('sends document bytes only to the presigned storage capability', async () => {
    const file = new File(['phase-three-upload'], 'invoice.pdf', {
      type: 'application/pdf',
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          expiresAt: '2026-07-21T11:00:00.000Z',
          plan: {
            headers: {
              'content-type': 'application/pdf',
              'x-amz-checksum-sha256': 'checksum',
            },
            method: 'PUT',
            type: 'SINGLE_PUT',
            url: 'https://storage.example/presigned-object',
          },
          uploadSessionId: 'upload-1',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ executionId: 'execution-1' }));
    const client = new AiFlowClient('https://engine.example', () => 'token-1');

    await expect(client.uploadFile('workflow-1', file)).resolves.toEqual({
      executionId: 'execution-1',
    });

    const [storageUrl, storageInit] = fetchMock.mock.calls[1] ?? [];
    expect(storageUrl).toBe('https://storage.example/presigned-object');
    expect(storageInit?.body).toBe(file);
    expect(new Headers(storageInit?.headers).has('Authorization')).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toBe(file);
    expect(fetchMock.mock.calls[2]?.[1]?.body).not.toBe(file);
  });
});
