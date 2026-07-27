const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.join(__dirname, '..');
const baseUrl = 'http://127.0.0.1:3104';
const token = 'aiflow-demo-token-a';
const projectId = 'demo-project-a';
const runId = randomUUID();
const children = [];

const request = async (pathname, init = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.code ?? `HTTP_${response.status}`);
  }
  return body.data;
};

const waitFor = async (label, read, achieved, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const value = await read();
      if (achieved(value)) return value;
    } catch (error) {
      if (index === attempts - 1) throw error;
    }
    await delay(500);
  }
  throw new Error(`${label.toUpperCase()}_TIMEOUT`);
};

const startRole = (role) => {
  const child = spawn(
    process.execPath,
    [path.join(root, 'scripts', 'aiflow-engine.cjs'), role],
    {
      cwd: root,
      env: {
        ...process.env,
        API_PORT: '3104',
        METRICS_ENABLED: 'false',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (bytes) => process.stderr.write(bytes));
  child.stderr.on('data', (bytes) => process.stderr.write(bytes));
  children.push(child);
};

const stopRoles = async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('exit', resolve);
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        }),
    ),
  );
};

const createConnection = (connectorId, displayName, configuration = {}) =>
  request('/api/v1/connections', {
    body: JSON.stringify({
      configuration,
      connectorId,
      displayName,
    }),
    headers: { 'Idempotency-Key': `${connectorId}-${runId}` },
    method: 'POST',
  });

const main = async () => {
  startRole('api');
  startRole('worker');
  startRole('scheduler');
  await waitFor(
    'api',
    () => fetch(`${baseUrl}/health/ready`),
    (response) => response.ok,
  );

  const sharePoint = await request('/api/v1/connectors/microsoft-sharepoint');
  if (
    sharePoint.actions[0]?.capability !== 'ENTRY' ||
    sharePoint.actions[0]?.provisioningMode !== 'MANAGED'
  ) {
    throw new Error('SHAREPOINT_DESCRIPTOR_INVALID');
  }

  const [entryConnection, destinationConnection] = await Promise.all([
    createConnection('microsoft-sharepoint', `Phase 4 SharePoint ${runId}`, {
      externalTenantId: '00000000-0000-4000-8000-000000000001',
      identityMode: 'SAAS_MULTITENANT',
      permissionProfile: 'FILES_AND_SITES_READ_ALL_V1',
    }),
    createConnection(
      'microsoft-business-central',
      `Phase 4 Business Central ${runId}`,
    ),
  ]);
  const authorization = await request(
    `/api/v1/connections/${entryConnection.id}/authorization`,
  );
  if (authorization.status !== 'AUTHORIZED') {
    throw new Error('SHAREPOINT_CONNECTION_NOT_AUTHORIZED');
  }
  const sites = await request(
    `/api/v1/connections/${entryConnection.id}/resources?resourceType=SITE`,
  );
  const drives = await request(
    `/api/v1/connections/${entryConnection.id}/resources?resourceType=DRIVE&parentResourceId=${encodeURIComponent('demo-sharepoint-site')}`,
  );
  const folders = await request(
    `/api/v1/connections/${entryConnection.id}/resources?resourceType=FOLDER&containerResourceId=${encodeURIComponent('demo-sharepoint-drive')}&parentResourceId=${encodeURIComponent('demo-sharepoint-root')}`,
  );
  if (
    sites[0]?.id !== 'demo-sharepoint-site' ||
    drives[0]?.id !== 'demo-sharepoint-drive' ||
    folders[0]?.id !== 'demo-sharepoint-inbound'
  ) {
    throw new Error('SHAREPOINT_RESOURCE_DISCOVERY_FAILED');
  }

  const workflow = await request(`/api/v1/projects/${projectId}/workflows`, {
    body: JSON.stringify({
      definition: {
        destination: {
          actionId: 'create-purchase-invoice-draft',
          config: { companyId: 'phase4-demo-company' },
          connectionId: destinationConnection.id,
          connectorId: 'microsoft-business-central',
        },
        entry: {
          config: {
            driveId: 'demo-sharepoint-drive',
            folderId: 'demo-sharepoint-inbound',
            includeSubfolders: true,
            siteId: 'demo-sharepoint-site',
          },
          connectionId: entryConnection.id,
          connectorId: 'microsoft-sharepoint',
        },
        extraction: { config: {}, profileId: 'invoice-basic' },
        mappings: [
          {
            required: true,
            sourceField: 'currency_code',
            targetField: 'currencyCode',
          },
          {
            required: true,
            sourceField: 'invoice_date',
            targetField: 'invoiceDate',
          },
          {
            required: true,
            sourceField: 'total',
            targetField: 'totalAmount',
          },
          {
            required: true,
            sourceField: 'invoice_number',
            targetField: 'vendorInvoiceNumber',
          },
          {
            required: true,
            sourceField: 'vendor_number',
            targetField: 'vendorNumber',
          },
        ],
        reviewPolicy: { required: false },
        schemaVersion: 1,
      },
      name: `Phase 4 SharePoint smoke ${runId}`,
    }),
    headers: { 'Idempotency-Key': `workflow-${runId}` },
    method: 'POST',
  });
  const activation = await request(
    `/api/v1/workflows/${workflow.id}/activation`,
    {
      body: JSON.stringify({ versionId: workflow.latestVersion.id }),
      headers: { 'Idempotency-Key': `activation-${runId}` },
      method: 'PUT',
    },
  );
  await waitFor(
    'activation',
    () => request(`/api/v1/provisioning-operations/${activation.id}`),
    (operation) => operation.status === 'SUCCEEDED',
  );

  const executions = await waitFor(
    'SharePoint execution',
    () => request(`/api/v1/workflows/${workflow.id}/executions`),
    (items) =>
      items.length === 1 &&
      ['FAILED', 'REJECTED', 'SUCCEEDED'].includes(items[0]?.status),
  );
  const execution = executions[0];
  if (
    execution.status !== 'SUCCEEDED' ||
    execution.originalFilename !== 'sharepoint-demo.pdf' ||
    execution.stageSummary.some(({ stage, status }) =>
      stage === 'REVIEW' ? status !== 'SKIPPED' : status !== 'SUCCEEDED',
    )
  ) {
    throw new Error(execution.failure?.code ?? 'SHAREPOINT_EXECUTION_FAILED');
  }

  await delay(2_000);
  const replayCheck = await request(
    `/api/v1/workflows/${workflow.id}/executions`,
  );
  if (replayCheck.length !== 1) {
    throw new Error('SHAREPOINT_SOURCE_VERSION_DUPLICATED');
  }

  const validationToken = `phase4-${runId}`;
  const validation = await fetch(
    `${baseUrl}/provider-callbacks/v1/microsoft-graph/sharepoint?validationToken=${encodeURIComponent(validationToken)}`,
    {
      headers: { 'Content-Type': 'text/plain' },
      method: 'POST',
    },
  );
  if (
    !validation.ok ||
    validation.headers.get('content-type')?.split(';')[0] !== 'text/plain' ||
    (await validation.text()) !== validationToken
  ) {
    throw new Error('SHAREPOINT_VALIDATION_CHALLENGE_FAILED');
  }

  const deactivation = await request(
    `/api/v1/workflows/${workflow.id}/activation`,
    {
      headers: { 'Idempotency-Key': `deactivation-${runId}` },
      method: 'DELETE',
    },
  );
  if (!deactivation.operation?.id) {
    throw new Error('SHAREPOINT_DEACTIVATION_OPERATION_MISSING');
  }
  await waitFor(
    'SharePoint deactivation',
    () =>
      request(`/api/v1/provisioning-operations/${deactivation.operation.id}`),
    (operation) => operation.status === 'SUCCEEDED',
  );
  const inactive = await request(`/api/v1/workflows/${workflow.id}/activation`);
  if (
    inactive.activeVersionId !== null ||
    inactive.acceptingNewDocuments ||
    inactive.cleanupRequired
  ) {
    throw new Error('SHAREPOINT_DEACTIVATION_INCOMPLETE');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        deactivationOperationId: deactivation.operation.id,
        executionId: execution.executionId,
        filename: execution.originalFilename,
        sourceConnector: 'microsoft-sharepoint',
        stages: execution.stageSummary.map(({ stage, status }) => ({
          stage,
          status,
        })),
        status: execution.status,
        workflowId: workflow.id,
      },
      null,
      2,
    )}\n`,
  );
};

void main()
  .finally(stopRoles)
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PHASE4_SMOKE_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
