export type ConnectorCapability = 'DESTINATION' | 'ENTRY';

export interface ConnectorActionView {
  readonly actionId: string;
  readonly capability: ConnectorCapability;
  readonly connectionRequired: boolean;
  readonly configurationSchema: Readonly<Record<string, unknown>>;
  readonly configurationSchemaVersion: number;
  readonly displayName: string;
  readonly provisioningMode: 'MANAGED' | 'NONE' | 'VALIDATE_ONLY';
  readonly version: number;
}

export interface ConnectorView {
  readonly actions: readonly ConnectorActionView[];
  readonly connectorId: string;
  readonly displayName: string;
  readonly version: number;
}

export interface ExtractionProfileView {
  readonly displayName: string;
  readonly outputFields: readonly string[];
  readonly outputSchemaHash: string;
  readonly profileId: string;
  readonly profileKind: 'CUSTOM' | 'SYSTEM';
  readonly profileVersionId: string;
}

export interface ConnectionView {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configurationSchemaVersion: number;
  readonly connectorId: string;
  readonly createdAt: string;
  readonly displayName: string;
  readonly health: 'DEGRADED' | 'HEALTHY' | 'UNKNOWN';
  readonly id: string;
  readonly stateVersion: number;
  readonly status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  readonly updatedAt: string;
}

export interface WorkflowDefinitionV1 {
  readonly schemaVersion: 1;
  readonly entry: {
    readonly connectorId: string;
    readonly connectionId?: string;
    readonly config: Readonly<Record<string, unknown>>;
  };
  readonly extraction: {
    readonly profileId: string;
    readonly config: Readonly<Record<string, unknown>>;
  };
  readonly mappings: readonly {
    readonly sourceField: string;
    readonly targetField: string;
    readonly required?: boolean;
  }[];
  readonly reviewPolicy:
    | { readonly required: false }
    | { readonly expiresAfterSeconds: number; readonly required: true };
  readonly destination: {
    readonly connectorId: string;
    readonly connectionId?: string;
    readonly actionId: string;
    readonly config: Readonly<Record<string, unknown>>;
  };
}

export interface WorkflowView {
  readonly acceptingNewDocuments: boolean;
  readonly activeVersionId: string | null;
  readonly cleanupRequired: boolean;
  readonly health: string;
  readonly id: string;
  readonly latestVersion: {
    readonly definition: WorkflowDefinitionV1;
    readonly id: string;
    readonly versionNumber: number;
  } | null;
  readonly name: string;
  readonly projectId: string;
  readonly status: string;
}

export interface WorkflowVersionView {
  readonly createdAt: string;
  readonly createdBy: {
    readonly id: string;
    readonly type: 'SERVICE' | 'SYSTEM' | 'USER';
  };
  readonly definition: WorkflowDefinitionV1;
  readonly definitionHash: string;
  readonly id: string;
  readonly profileReference: {
    readonly outputSchemaHash: string;
    readonly profileId: string;
    readonly profileKind: 'CUSTOM' | 'SYSTEM';
    readonly profileVersionId: string;
  };
  readonly schemaVersion: 1;
  readonly status: 'VALID';
  readonly versionNumber: number;
  readonly workflowId: string;
}

export interface ProvisioningOperationView {
  readonly activeVersionId: string | null;
  readonly createdAt: string;
  readonly currentStep:
    'DEPROVISION' | 'PROVISION' | 'RECONCILE' | 'SWITCH' | 'VALIDATE';
  readonly failure: null;
  readonly id: string;
  readonly kind: 'ACTIVATE' | 'DEACTIVATE';
  readonly status:
    | 'FAILED'
    | 'PENDING'
    | 'RECONCILING'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'WAITING_RETRY';
  readonly targetVersionId: string | null;
  readonly updatedAt: string;
  readonly workflowId: string;
}

export interface WorkflowActivationView {
  readonly acceptingNewDocuments: boolean;
  readonly activeVersionId: string | null;
  readonly cleanupRequired: boolean;
  readonly health: 'DEGRADED' | 'HEALTHY' | 'UNKNOWN';
  readonly operation: ProvisioningOperationView | null;
  readonly targetVersionId: string | null;
  readonly workflowId: string;
}

export interface UploadPlan {
  readonly expiresAt: string;
  readonly uploadSessionId: string;
  readonly plan:
    | {
        readonly headers: Readonly<Record<string, string>>;
        readonly method: 'PUT';
        readonly type: 'SINGLE_PUT';
        readonly url: string;
      }
    | {
        readonly partCount: number;
        readonly partSizeBytes: number;
        readonly type: 'MULTIPART';
      };
}

export interface ExecutionView {
  readonly allowedActions: readonly ('RECONCILE' | 'RETRY')[];
  readonly auditTrail?: readonly {
    readonly action: string;
    readonly occurredAt: string;
    readonly outcome: string;
  }[];
  readonly currentStage: string;
  readonly executionId: string;
  readonly failure: {
    readonly category: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly stageSummary: readonly {
    readonly attempts: number;
    readonly stage: string;
    readonly status: string;
  }[];
  readonly status: string;
}

export class AiFlowApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'AiFlowApiError';
  }
}

const randomKey = (scope: string): string => `${scope}-${crypto.randomUUID()}`;

const sha256Base64 = async (value: Blob | ArrayBuffer): Promise<string> => {
  const bytes = value instanceof Blob ? await value.arrayBuffer() : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let binary = '';
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export class AiFlowClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken?: () => string | undefined,
  ) {}

  listConnectors(
    capability?: ConnectorCapability,
  ): Promise<readonly ConnectorView[]> {
    const query =
      capability === undefined
        ? ''
        : `?capability=${encodeURIComponent(capability)}`;
    return this.requestList(`/api/v1/connectors${query}`);
  }

  getConnector(connectorId: string): Promise<ConnectorView> {
    return this.request(
      `/api/v1/connectors/${encodeURIComponent(connectorId)}`,
    );
  }

  listExtractionProfiles(): Promise<readonly ExtractionProfileView[]> {
    return this.requestList('/api/v1/extraction-profiles');
  }

  getExtractionProfile(profileId: string): Promise<ExtractionProfileView> {
    return this.request(
      `/api/v1/extraction-profiles/${encodeURIComponent(profileId)}`,
    );
  }

  createConnection(input: {
    readonly connectorId: string;
    readonly displayName: string;
    readonly idempotencyKey?: string;
  }): Promise<ConnectionView> {
    return this.request('/api/v1/connections', {
      body: JSON.stringify({
        configuration: {},
        connectorId: input.connectorId,
        displayName: input.displayName,
      }),
      headers: {
        'Idempotency-Key':
          input.idempotencyKey ?? randomKey('connection-create'),
      },
      method: 'POST',
    });
  }

  listConnections(connectorId?: string): Promise<readonly ConnectionView[]> {
    const query =
      connectorId === undefined
        ? ''
        : `?connectorId=${encodeURIComponent(connectorId)}`;
    return this.requestList(`/api/v1/connections${query}`);
  }

  getConnection(connectionId: string): Promise<ConnectionView> {
    return this.request(
      `/api/v1/connections/${encodeURIComponent(connectionId)}`,
    );
  }

  updateConnection(input: {
    readonly connectionId: string;
    readonly displayName: string;
    readonly expectedStateVersion: number;
    readonly idempotencyKey?: string;
  }): Promise<ConnectionView> {
    return this.request(
      `/api/v1/connections/${encodeURIComponent(input.connectionId)}`,
      {
        body: JSON.stringify({
          displayName: input.displayName,
          expectedStateVersion: input.expectedStateVersion,
        }),
        headers: {
          'Idempotency-Key':
            input.idempotencyKey ?? randomKey('connection-update'),
        },
        method: 'PATCH',
      },
    );
  }

  revokeConnection(input: {
    readonly connectionId: string;
    readonly idempotencyKey?: string;
  }): Promise<ConnectionView> {
    return this.request(
      `/api/v1/connections/${encodeURIComponent(input.connectionId)}`,
      {
        headers: {
          'Idempotency-Key':
            input.idempotencyKey ?? randomKey('connection-revoke'),
        },
        method: 'DELETE',
      },
    );
  }

  listWorkflows(projectId: string): Promise<readonly WorkflowView[]> {
    return this.requestList(
      `/api/v1/projects/${encodeURIComponent(projectId)}/workflows`,
    );
  }

  createWorkflow(input: {
    readonly projectId: string;
    readonly name: string;
    readonly definition: WorkflowDefinitionV1;
    readonly idempotencyKey?: string;
  }): Promise<WorkflowView> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(input.projectId)}/workflows`,
      {
        body: JSON.stringify({
          definition: input.definition,
          name: input.name,
        }),
        headers: {
          'Idempotency-Key': input.idempotencyKey ?? randomKey('workflow'),
        },
        method: 'POST',
      },
    );
  }

  getWorkflow(workflowId: string): Promise<WorkflowView> {
    return this.request(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
  }

  archiveWorkflow(input: {
    readonly idempotencyKey?: string;
    readonly workflowId: string;
  }): Promise<WorkflowView> {
    return this.request(
      `/api/v1/workflows/${encodeURIComponent(input.workflowId)}`,
      {
        headers: {
          'Idempotency-Key':
            input.idempotencyKey ?? randomKey('workflow-archive'),
        },
        method: 'DELETE',
      },
    );
  }

  createWorkflowVersion(input: {
    readonly basedOnVersionId: string;
    readonly definition: WorkflowDefinitionV1;
    readonly idempotencyKey?: string;
    readonly workflowId: string;
  }): Promise<WorkflowVersionView> {
    return this.request(
      `/api/v1/workflows/${encodeURIComponent(input.workflowId)}/versions`,
      {
        body: JSON.stringify({
          basedOnVersionId: input.basedOnVersionId,
          definition: input.definition,
        }),
        headers: {
          'Idempotency-Key':
            input.idempotencyKey ?? randomKey('workflow-version'),
        },
        method: 'POST',
      },
    );
  }

  listWorkflowVersions(
    workflowId: string,
  ): Promise<readonly WorkflowVersionView[]> {
    return this.requestList(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/versions`,
    );
  }

  getWorkflowVersion(
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersionView> {
    return this.request(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}`,
    );
  }

  activateWorkflow(input: {
    readonly workflowId: string;
    readonly versionId: string;
    readonly idempotencyKey?: string;
  }): Promise<ProvisioningOperationView> {
    return this.request(
      `/api/v1/workflows/${encodeURIComponent(input.workflowId)}/activation`,
      {
        body: JSON.stringify({ versionId: input.versionId }),
        headers: {
          'Idempotency-Key': input.idempotencyKey ?? randomKey('activation'),
        },
        method: 'PUT',
      },
    );
  }

  getProvisioningOperation(
    operationId: string,
  ): Promise<ProvisioningOperationView> {
    return this.request(
      `/api/v1/provisioning-operations/${encodeURIComponent(operationId)}`,
    );
  }

  getWorkflowActivation(workflowId: string): Promise<WorkflowActivationView> {
    return this.request(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/activation`,
    );
  }

  deactivateWorkflow(input: {
    readonly idempotencyKey?: string;
    readonly workflowId: string;
  }): Promise<WorkflowActivationView> {
    return this.request(
      `/api/v1/workflows/${encodeURIComponent(input.workflowId)}/activation`,
      {
        headers: {
          'Idempotency-Key':
            input.idempotencyKey ?? randomKey('workflow-deactivation'),
        },
        method: 'DELETE',
      },
    );
  }

  getExecution(executionId: string): Promise<ExecutionView> {
    return this.request(
      `/api/v1/executions/${encodeURIComponent(executionId)}`,
    );
  }

  retryExecution(executionId: string): Promise<ExecutionView> {
    return this.request(
      `/api/v1/executions/${encodeURIComponent(executionId)}/retries`,
      {
        headers: { 'Idempotency-Key': randomKey('retry') },
        method: 'POST',
      },
    );
  }

  async uploadFile(
    workflowId: string,
    file: File,
  ): Promise<{ readonly executionId: string }> {
    const checksum = await sha256Base64(file);
    const upload = await this.request<UploadPlan>(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/upload-sessions`,
      {
        body: JSON.stringify({
          checksum: { algorithm: 'SHA256', value: checksum },
          contentType: file.type || 'application/octet-stream',
          originalFilename: file.name,
          sizeBytes: file.size,
        }),
        headers: { 'Idempotency-Key': randomKey('upload') },
        method: 'POST',
      },
    );
    const parts =
      upload.plan.type === 'SINGLE_PUT'
        ? await this.singlePut(upload.plan, file)
        : await this.multipartPut(upload.uploadSessionId, upload.plan, file);
    return this.request(
      `/api/v1/upload-sessions/${encodeURIComponent(upload.uploadSessionId)}/complete`,
      {
        body: JSON.stringify({ parts }),
        headers: { 'Idempotency-Key': randomKey('complete') },
        method: 'POST',
      },
    );
  }

  private async singlePut(
    plan: Extract<UploadPlan['plan'], { type: 'SINGLE_PUT' }>,
    file: File,
  ): Promise<undefined> {
    const response = await fetch(plan.url, {
      body: file,
      headers: plan.headers,
      method: plan.method,
    });
    if (!response.ok) {
      throw new AiFlowApiError(
        'UPLOAD_TRANSFER_FAILED',
        true,
        'The file upload failed',
      );
    }
    return undefined;
  }

  private async multipartPut(
    uploadSessionId: string,
    plan: Extract<UploadPlan['plan'], { type: 'MULTIPART' }>,
    file: File,
  ) {
    const receipts: {
      checksumValue: string;
      etag: string;
      partNumber: number;
    }[] = [];
    for (let index = 0; index < plan.partCount; index += 1) {
      const partNumber = index + 1;
      const part = file.slice(
        index * plan.partSizeBytes,
        Math.min(file.size, partNumber * plan.partSizeBytes),
      );
      const checksumValue = await sha256Base64(part);
      const capability = await this.request<{
        readonly headers: Readonly<Record<string, string>>;
        readonly method: 'PUT';
        readonly url: string;
      }>(
        `/api/v1/upload-sessions/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}/upload-capabilities`,
        {
          body: JSON.stringify({
            checksumValue,
            contentLength: part.size,
          }),
          method: 'POST',
        },
      );
      const uploaded = await fetch(capability.url, {
        body: part,
        headers: capability.headers,
        method: capability.method,
      });
      const etag = uploaded.headers.get('etag');
      if (!uploaded.ok || etag === null) {
        throw new AiFlowApiError(
          'UPLOAD_TRANSFER_FAILED',
          true,
          'A multipart upload failed',
        );
      }
      receipts.push({ checksumValue, etag, partNumber });
    }
    return receipts;
  }

  private async requestList<T>(path: string): Promise<readonly T[]> {
    const response = await this.raw(path);
    return ((await response.json()) as { data: T[] }).data;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);
    return ((await response.json()) as { data: T }).data;
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = this.accessToken?.()?.trim();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(`${this.baseUrl.replace(/\/$/u, '')}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; retryable?: boolean };
      };
      throw new AiFlowApiError(
        body.error?.code ?? 'REQUEST_FAILED',
        body.error?.retryable ?? false,
        body.error?.message ?? 'The request failed',
      );
    }
    return response;
  }
}
