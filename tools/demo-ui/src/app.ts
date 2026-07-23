import {
  AiFlowApiError,
  AiFlowClient,
  type ExecutionView,
  type WorkflowDefinitionV1,
  type WorkflowView,
} from '@aiflow/api-client';

const api = new AiFlowClient(
  'http://localhost:3000',
  () => 'aiflow-demo-token-a',
);
const projectId = 'demo-project-a';
let workflows: readonly WorkflowView[] = [];
let currentExecutionId: string | undefined;
let wizardStep = 0;

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found === null) throw new Error(`Missing element: ${id}`);
  return found;
};

const showNotice = (message: string): void => {
  const notice = element('notice');
  notice.textContent = message;
  notice.classList.remove('hidden');
};

const clearNotice = (): void => element('notice').classList.add('hidden');

const describeError = (error: unknown): string =>
  error instanceof AiFlowApiError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';

const activateView = (id: string): void => {
  document
    .querySelectorAll('.view')
    .forEach((view) => view.classList.toggle('hidden', view.id !== id));
  document
    .querySelectorAll<HTMLButtonElement>('.nav')
    .forEach((button) =>
      button.classList.toggle('active', button.dataset.view === id),
    );
  clearNotice();
};

const renderWorkflows = (): void => {
  const list = element('workflow-list');
  list.replaceChildren();
  if (workflows.length === 0) {
    list.innerHTML =
      '<div class="card"><p>No workflows yet. Create the first invoice flow.</p></div>';
  }
  for (const workflow of workflows) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div><h3>${workflow.name}</h3><p>${workflow.status} · ${workflow.health}</p></div>
      <span class="pill">${workflow.acceptingNewDocuments ? 'Accepting uploads' : 'Inactive'}</span>
    `;
    list.append(card);
  }
  const select = element<HTMLSelectElement>('upload-workflow');
  select.replaceChildren();
  for (const workflow of workflows.filter(
    (candidate) => candidate.acceptingNewDocuments,
  )) {
    select.add(new Option(workflow.name, workflow.id));
  }
};

const loadWorkflows = async (): Promise<void> => {
  try {
    workflows = await api.listWorkflows(projectId);
    renderWorkflows();
    element('connection').textContent = 'Engine connected';
  } catch (error) {
    element('connection').textContent = 'Engine unavailable';
    showNotice(describeError(error));
  }
};

const definition = (connectionId: string): WorkflowDefinitionV1 => ({
  destination: {
    actionId: 'create-purchase-invoice-draft',
    config: { companyId: element<HTMLInputElement>('company-id').value },
    connectionId,
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
    { required: true, sourceField: 'total', targetField: 'totalAmount' },
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
});

const renderWizard = (): void => {
  document
    .querySelectorAll<HTMLElement>('[data-step]')
    .forEach((field) =>
      field.classList.toggle(
        'hidden',
        Number(field.dataset.step) !== wizardStep,
      ),
    );
  document
    .querySelectorAll('.step')
    .forEach((step, index) =>
      step.classList.toggle('active', index === wizardStep),
    );
  element<HTMLButtonElement>('back').disabled = wizardStep === 0;
  element('next').classList.toggle('hidden', wizardStep === 2);
  element('create-submit').classList.toggle('hidden', wizardStep !== 2);
  if (wizardStep === 2) {
    element('summary').innerHTML = `
      <strong>${element<HTMLInputElement>('workflow-name').value}</strong><br />
      Direct upload → Basic invoice extraction → Business Central<br />
      Company: ${element<HTMLInputElement>('company-id').value}<br />
      Five required field mappings · No human review
    `;
  }
};

const waitForActivation = async (operationId: string): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const operation = await api.getProvisioningOperation(operationId);
    if (operation.status === 'SUCCEEDED') return;
    if (operation.status === 'FAILED')
      throw new Error('Workflow activation failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Workflow activation timed out');
};

const createWorkflow = async (): Promise<void> => {
  const connection = await api.createConnection({
    connectorId: 'microsoft-business-central',
    displayName: `${element<HTMLInputElement>('workflow-name').value} Business Central`,
  });
  const created = await api.createWorkflow({
    definition: definition(connection.id),
    name: element<HTMLInputElement>('workflow-name').value,
    projectId,
  });
  if (created.latestVersion === null)
    throw new Error('Workflow version missing');
  const operation = await api.activateWorkflow({
    versionId: created.latestVersion.id,
    workflowId: created.id,
  });
  showNotice('Workflow created. Waiting for activation…');
  await waitForActivation(operation.id);
  await loadWorkflows();
  activateView('workflows');
};

const renderExecution = (execution: ExecutionView): void => {
  element('execution').classList.remove('hidden');
  element('execution-status').textContent = execution.status;
  const stages = element('stages');
  stages.innerHTML = execution.stageSummary
    .map(
      (stage) =>
        `<div class="stage"><strong>${stage.stage}</strong>${stage.status} · ${stage.attempts} attempt${stage.attempts === 1 ? '' : 's'}</div>`,
    )
    .join('');
  const failure = element('failure');
  failure.classList.toggle('hidden', execution.failure === null);
  failure.textContent =
    execution.failure === null
      ? ''
      : JSON.stringify(execution.failure, null, 2);
  element('retry').classList.toggle(
    'hidden',
    !execution.allowedActions.includes('RETRY'),
  );
};

const pollExecution = async (executionId: string): Promise<void> => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const execution = await api.getExecution(executionId);
    renderExecution(execution);
    if (['FAILED', 'REJECTED', 'SUCCEEDED'].includes(execution.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  showNotice('Execution is still running. You can refresh later.');
};

document.querySelectorAll<HTMLButtonElement>('.nav').forEach((button) => {
  button.addEventListener('click', () =>
    activateView(button.dataset.view ?? 'workflows'),
  );
});
element('refresh').addEventListener('click', () => void loadWorkflows());
element('next').addEventListener('click', () => {
  wizardStep = Math.min(2, wizardStep + 1);
  renderWizard();
});
element('back').addEventListener('click', () => {
  wizardStep = Math.max(0, wizardStep - 1);
  renderWizard();
});
element<HTMLFormElement>('wizard').addEventListener('submit', (event) => {
  event.preventDefault();
  void createWorkflow().catch((error: unknown) =>
    showNotice(describeError(error)),
  );
});
element<HTMLFormElement>('upload-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const workflowId = element<HTMLSelectElement>('upload-workflow').value;
  const file = element<HTMLInputElement>('document').files?.[0];
  if (workflowId.length === 0 || file === undefined) {
    showNotice('Select an active workflow and a document.');
    return;
  }
  clearNotice();
  void api
    .uploadFile(workflowId, file)
    .then(async ({ executionId }) => {
      currentExecutionId = executionId;
      await pollExecution(executionId);
    })
    .catch((error: unknown) => showNotice(describeError(error)));
});
element('retry').addEventListener('click', () => {
  if (currentExecutionId === undefined) return;
  void api
    .retryExecution(currentExecutionId)
    .then(async (execution) => {
      currentExecutionId = execution.executionId;
      await pollExecution(execution.executionId);
    })
    .catch((error: unknown) => showNotice(describeError(error)));
});

renderWizard();
void loadWorkflows();
