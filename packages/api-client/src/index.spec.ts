import { AiFlowClient, type WorkflowDefinitionV1 } from './index';

const definition: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  destination: {
    actionId: 'create-purchase-invoice-draft',
    config: { companyId: 'company-1' },
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
