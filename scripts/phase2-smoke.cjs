const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.join(__dirname, '..');
const baseUrl = 'http://127.0.0.1:3100';
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

const waitFor = async (label, read, achieved, attempts = 120) => {
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

const startRole = (role, arguments_ = []) => {
  const child = spawn(
    process.execPath,
    [path.join(root, 'scripts', 'aiflow-engine.cjs'), role, ...arguments_],
    {
      cwd: root,
      env: {
        ...process.env,
        API_PORT: '3100',
        METRICS_ENABLED: 'false',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (bytes) => process.stderr.write(bytes));
  child.stderr.on('data', (bytes) => process.stderr.write(bytes));
  children.push(child);
  return child;
};

const stopRole = async (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  });

const stopRoles = async () => {
  await Promise.all(children.map((child) => stopRole(child)));
};

const main = async () => {
  const api = startRole('api');
  startRole('worker');
  startRole('scheduler');
  await waitFor(
    'api',
    () => fetch(`${baseUrl}/health/ready`),
    (response) => response.ok,
  );

  const entryConnectors = await request('/api/v1/connectors?capability=ENTRY');
  const directUploadDescriptor = await request(
    '/api/v1/connectors/direct-upload',
  );
  const extractionProfiles = await request('/api/v1/extraction-profiles');
  const invoiceProfile = await request(
    '/api/v1/extraction-profiles/invoice-basic',
  );
  if (
    entryConnectors.length !== 1 ||
    entryConnectors[0]?.connectorId !== 'direct-upload' ||
    directUploadDescriptor.actions[0]?.capability !== 'ENTRY' ||
    extractionProfiles.length !== 1 ||
    extractionProfiles[0]?.profileId !== 'invoice-basic' ||
    invoiceProfile.displayName !== 'Basic invoice'
  ) {
    throw new Error('SMOKE_CATALOG_INVALID');
  }

  const connectionKey = `connection-${runId}`;
  const connection = await request('/api/v1/connections', {
    body: JSON.stringify({
      configuration: {},
      connectorId: 'microsoft-business-central',
      displayName: `Phase 2 Business Central ${runId}`,
    }),
    headers: { 'Idempotency-Key': connectionKey },
    method: 'POST',
  });
  const replayedConnection = await request('/api/v1/connections', {
    body: JSON.stringify({
      configuration: {},
      connectorId: 'microsoft-business-central',
      displayName: `Phase 2 Business Central ${runId}`,
    }),
    headers: { 'Idempotency-Key': connectionKey },
    method: 'POST',
  });
  const renamedConnection = await request(
    `/api/v1/connections/${connection.id}`,
    {
      body: JSON.stringify({
        displayName: `Phase 2 BC ${runId}`,
        expectedStateVersion: connection.stateVersion,
      }),
      headers: { 'Idempotency-Key': `connection-update-${runId}` },
      method: 'PATCH',
    },
  );
  const visibleConnections = await request(
    '/api/v1/connections?connectorId=microsoft-business-central',
  );
  if (
    JSON.stringify(replayedConnection) !== JSON.stringify(connection) ||
    renamedConnection.stateVersion !== connection.stateVersion + 1 ||
    !visibleConnections.some((candidate) => candidate.id === connection.id)
  ) {
    throw new Error('SMOKE_CONNECTION_INVALID');
  }

  const workflow = await request(`/api/v1/projects/${projectId}/workflows`, {
    body: JSON.stringify({
      definition: {
        destination: {
          actionId: 'create-purchase-invoice-draft',
          config: { companyId: 'phase2-demo-company' },
          connectionId: connection.id,
          connectorId: 'microsoft-business-central',
        },
        entry: { config: {}, connectorId: 'direct-upload' },
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
      name: `Phase 2 smoke ${runId}`,
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

  const document = Buffer.from(`%PDF-1.4\nAiFlow Phase 2 ${runId}\n%%EOF\n`);
  const checksum = createHash('sha256').update(document).digest('base64');
  const upload = await request(
    `/api/v1/workflows/${workflow.id}/upload-sessions`,
    {
      body: JSON.stringify({
        checksum: { algorithm: 'SHA256', value: checksum },
        contentType: 'application/pdf',
        originalFilename: 'phase2-smoke.pdf',
        sizeBytes: document.length,
      }),
      headers: { 'Idempotency-Key': `upload-${runId}` },
      method: 'POST',
    },
  );
  if (upload.plan.type !== 'SINGLE_PUT') {
    throw new Error('SMOKE_UPLOAD_PLAN_UNEXPECTED');
  }
  const uploadHeaderNames = Object.keys(upload.plan.headers).join(',');
  const preflight = await fetch(upload.plan.url, {
    headers: {
      'Access-Control-Request-Headers': uploadHeaderNames,
      'Access-Control-Request-Method': 'PUT',
      Origin: 'http://localhost:4173',
    },
    method: 'OPTIONS',
  });
  const allowedHeaders = preflight.headers
    .get('access-control-allow-headers')
    ?.toLowerCase();
  if (
    !preflight.ok ||
    preflight.headers.get('access-control-allow-origin') !==
      'http://localhost:4173' ||
    Object.keys(upload.plan.headers).some(
      (header) =>
        !allowedHeaders
          ?.split(',')
          .map((item) => item.trim())
          .includes(header),
    )
  ) {
    throw new Error('SMOKE_STORAGE_CORS_PREFLIGHT_FAILED');
  }
  const transfer = await fetch(upload.plan.url, {
    body: document,
    headers: upload.plan.headers,
    method: 'PUT',
  });
  if (!transfer.ok) throw new Error(`SMOKE_STORAGE_UPLOAD_${transfer.status}`);

  const accepted = await request(
    `/api/v1/upload-sessions/${upload.uploadSessionId}/complete`,
    {
      body: '{}',
      headers: { 'Idempotency-Key': `complete-${runId}` },
      method: 'POST',
    },
  );
  await stopRole(api);
  startRole('api');
  await waitFor(
    'api restart',
    () => fetch(`${baseUrl}/health/ready`),
    (response) => response.ok,
  );
  const execution = await waitFor(
    'execution',
    () => request(`/api/v1/executions/${accepted.executionId}`),
    (candidate) =>
      ['FAILED', 'REJECTED', 'SUCCEEDED'].includes(candidate.status),
    180,
  );
  if (execution.status !== 'SUCCEEDED') {
    throw new Error(execution.failure?.code ?? 'PHASE2_EXECUTION_FAILED');
  }
  const activeState = await request(
    `/api/v1/workflows/${workflow.id}/activation`,
  );
  if (
    activeState.activeVersionId !== workflow.latestVersion.id ||
    !activeState.acceptingNewDocuments ||
    activeState.operation !== null
  ) {
    throw new Error('SMOKE_ACTIVATION_PROJECTION_INVALID');
  }
  const deactivationKey = `deactivation-${runId}`;
  const deactivated = await request(
    `/api/v1/workflows/${workflow.id}/activation`,
    {
      headers: { 'Idempotency-Key': deactivationKey },
      method: 'DELETE',
    },
  );
  const replayedDeactivation = await request(
    `/api/v1/workflows/${workflow.id}/activation`,
    {
      headers: { 'Idempotency-Key': deactivationKey },
      method: 'DELETE',
    },
  );
  if (
    deactivated.activeVersionId !== null ||
    deactivated.acceptingNewDocuments ||
    JSON.stringify(replayedDeactivation) !== JSON.stringify(deactivated)
  ) {
    throw new Error('SMOKE_DEACTIVATION_INVALID');
  }
  const closedUploadResponse = await fetch(
    `${baseUrl}/api/v1/workflows/${workflow.id}/upload-sessions`,
    {
      body: JSON.stringify({
        checksum: { algorithm: 'SHA256', value: checksum },
        contentType: 'application/pdf',
        originalFilename: 'closed-workflow.pdf',
        sizeBytes: document.length,
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `closed-upload-${runId}`,
      },
      method: 'POST',
    },
  );
  const closedUploadBody = await closedUploadResponse.json();
  if (
    closedUploadResponse.ok ||
    closedUploadBody.error?.code !== 'WORKFLOW_NOT_ACCEPTING_DOCUMENTS'
  ) {
    throw new Error('SMOKE_DEACTIVATION_GATE_FAILED');
  }
  const archiveKey = `archive-${runId}`;
  const archived = await request(`/api/v1/workflows/${workflow.id}`, {
    headers: { 'Idempotency-Key': archiveKey },
    method: 'DELETE',
  });
  const replayedArchive = await request(`/api/v1/workflows/${workflow.id}`, {
    headers: { 'Idempotency-Key': archiveKey },
    method: 'DELETE',
  });
  const visibleWorkflows = await request(
    `/api/v1/projects/${projectId}/workflows`,
  );
  if (
    archived.status !== 'ARCHIVED' ||
    JSON.stringify(replayedArchive) !== JSON.stringify(archived) ||
    visibleWorkflows.some((candidate) => candidate.id === workflow.id)
  ) {
    throw new Error('SMOKE_WORKFLOW_ARCHIVE_FAILED');
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        executionId: execution.executionId,
        stages: execution.stageSummary.map(({ stage, status }) => ({
          stage,
          status,
        })),
        status: execution.status,
        workflowArchived: archived.status === 'ARCHIVED',
        workflowAcceptingNewDocuments: deactivated.acceptingNewDocuments,
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
      `${error instanceof Error ? error.message : 'PHASE2_SMOKE_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
