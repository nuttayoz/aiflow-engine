import { createHash } from 'node:crypto';

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { microsoftBusinessCentralConnector } from '@aiflow/connector-microsoft-business-central';
import { directUploadConnector } from '@aiflow/connector-direct-upload';
import {
  AesGcmSharePointCursorProtector,
  createDemoSharePointGraphAdapter,
  HttpSharePointGraphAdapter,
  isSharePointConnectionConfiguration,
  MicrosoftEntraClientCredentialsTokenProvider,
  microsoftSharePointConnector,
  SharePointResourceBrowser,
  SharePointGraphError,
  type SharePointCursorProtector,
  type SharePointGraphPort,
} from '@aiflow/connector-microsoft-sharepoint';
import {
  ConnectorRegistry,
  type ConnectorDescriptor,
} from '@aiflow/connector-sdk';
import type { S3RuntimeConfig, SharePointRuntimeConfig } from '@aiflow/config';
import {
  DatabaseService,
  PostgresConnectionRepository,
  PostgresDocumentRepository,
  PostgresExecutionRepository,
  PostgresPipelineRepository,
  PostgresSharePointConnectionAuthority,
  PostgresUploadSessionRepository,
  PostgresWorkflowProvisioningRepository,
  PostgresWorkflowRepository,
} from '@aiflow/database';
import type {
  ConnectionRecord,
  ConnectionResourceBrowser,
  ConnectionResourceType,
} from '@aiflow/connections';
import type { ExecutionRecord } from '@aiflow/executions';
import {
  InMemoryExtractionProfileCatalog,
  PHASE2_INVOICE_PROFILE,
  type ExtractionProfileDescriptor,
  verifyExtractionCallback,
} from '@aiflow/extraction';
import {
  DirectUploadService,
  type MultipartCompletionReceipt,
  S3ObjectStorage,
} from '@aiflow/storage';
import {
  WorkflowDefinitionValidator,
  type ProvisioningOperationRecord,
  type WorkflowDefinitionV1,
  type WorkflowDeactivationResult,
  type WorkflowRecord,
  type WorkflowVersionRecord,
} from '@aiflow/workflows';

import type { ApiAuthorization } from './api-auth';
import { authorizeProject } from './api-auth';

export const API_S3_CONFIG = Symbol('API_S3_CONFIG');
export const API_SHAREPOINT_CONFIG = Symbol('API_SHAREPOINT_CONFIG');
export const API_SYNTHETIC_PROVIDERS_ENABLED = Symbol(
  'API_SYNTHETIC_PROVIDERS_ENABLED',
);

const profiles = new InMemoryExtractionProfileCatalog([PHASE2_INVOICE_PROFILE]);

const uuidFrom = (scope: string, tenantId: string, key: string): string => {
  const hex = createHash('sha256')
    .update(`${scope}\u0000${tenantId}\u0000${key}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const requireIdempotencyKey = (value: string | undefined): string => {
  const key = value?.trim();
  if (key === undefined || key.length === 0 || key.length > 256) {
    throw new Error('IDEMPOTENCY_KEY_INVALID');
  }
  return key;
};

const requireRecord = (
  value: unknown,
  code: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
};

const projectWorkflow = (
  authorization: ApiAuthorization,
  workflow: WorkflowRecord | undefined,
): WorkflowRecord => {
  if (workflow === undefined) throw new Error('WORKFLOW_NOT_FOUND');
  authorizeProject(authorization, workflow.projectId);
  return workflow;
};

const executionView = (
  execution: ExecutionRecord,
  originalFilename?: string,
) => ({
  allowedActions:
    execution.status === 'FAILED' &&
    ['EXTRACT', 'MAP'].includes(execution.currentStage)
      ? ['RETRY']
      : [],
  completedAt: execution.completedAt,
  correlationId: execution.correlationId,
  createdAt: execution.createdAt,
  currentStage: execution.currentStage,
  documentId: execution.documentId,
  executionId: execution.executionId,
  failure: execution.failure ?? null,
  originalFilename: originalFilename ?? null,
  retryOfExecutionId: execution.retryOfExecutionId,
  stageSummary: ['EXTRACT', 'MAP', 'REVIEW', 'DELIVER'].map((stage) => {
    const snapshot = execution.stages[stage as keyof typeof execution.stages];
    return {
      attempts: snapshot.attemptCount,
      failure: snapshot.failure ?? null,
      stage: snapshot.stage,
      status: snapshot.status,
    };
  }),
  stateVersion: execution.stateVersion,
  status: execution.status,
  transitionedAt: execution.transitionedAt,
  workflowId: execution.workflowId,
  workflowVersionId: execution.workflowVersionId,
});

const workflowVersionView = (version: WorkflowVersionRecord) => ({
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  definition: version.definition.definition,
  definitionHash: version.definition.definitionHash,
  id: version.id,
  profileReference: version.definition.profileReference,
  schemaVersion: version.definition.definition.schemaVersion,
  status: 'VALID' as const,
  versionNumber: version.versionNumber,
  workflowId: version.workflowId,
});

const provisioningOperationView = (
  operation: ProvisioningOperationRecord,
  activeVersionId?: string,
) => ({
  activeVersionId: activeVersionId ?? null,
  createdAt: operation.createdAt,
  currentStep: operation.currentStep,
  failure: null,
  id: operation.id,
  kind: operation.kind,
  status: operation.status,
  targetVersionId: operation.targetVersionId ?? null,
  updatedAt: operation.updatedAt,
  workflowId: operation.workflowId,
});

const activationView = (
  workflow: WorkflowRecord,
  operation?: ProvisioningOperationRecord,
) => ({
  acceptingNewDocuments: workflow.acceptingNewDocuments,
  activeVersionId: workflow.activeVersionId ?? null,
  cleanupRequired: workflow.cleanupRequired,
  health: workflow.health,
  operation:
    operation === undefined
      ? null
      : provisioningOperationView(operation, workflow.activeVersionId),
  targetVersionId: operation?.targetVersionId ?? null,
  workflowId: workflow.id,
});

const deactivationView = (
  result: WorkflowDeactivationResult,
  operation?: ProvisioningOperationRecord,
) => ({
  acceptingNewDocuments: result.acceptingNewDocuments,
  activeVersionId: result.activeVersionId ?? null,
  cleanupRequired: result.cleanupRequired,
  health: result.health,
  operation:
    operation === undefined
      ? null
      : provisioningOperationView(operation, result.activeVersionId),
  targetVersionId: null,
  workflowId: result.workflowId,
});

const connectionView = (connection: ConnectionRecord) => ({
  configuration: connection.configuration,
  configurationSchemaVersion: connection.configurationSchemaVersion,
  connectorId: connection.connectorId,
  createdAt: connection.createdAt,
  displayName: connection.displayName,
  health: connection.health,
  id: connection.id,
  stateVersion: connection.stateVersion,
  status: connection.status,
  updatedAt: connection.updatedAt,
});

@Injectable()
export class ApiService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private connections?: PostgresConnectionRepository;
  private documents?: PostgresDocumentRepository;
  private executions?: PostgresExecutionRepository;
  private pipeline?: PostgresPipelineRepository;
  private provisioning?: PostgresWorkflowProvisioningRepository;
  private sessions?: PostgresUploadSessionRepository;
  private storage?: S3ObjectStorage;
  private uploads?: DirectUploadService;
  private workflows?: PostgresWorkflowRepository;
  private readonly connectors = new ConnectorRegistry([
    directUploadConnector,
    microsoftBusinessCentralConnector,
    microsoftSharePointConnector,
  ]);
  private readonly resourceBrowsers = new Map<
    string,
    ConnectionResourceBrowser
  >();
  private sharePointStateProtector?: SharePointCursorProtector;
  private sharePointTokens?: MicrosoftEntraClientCredentialsTokenProvider;
  private readonly validator = new WorkflowDefinitionValidator(
    this.connectors,
    profiles,
  );

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(API_S3_CONFIG) private readonly s3Config: S3RuntimeConfig,
    @Inject(API_SHAREPOINT_CONFIG)
    private readonly sharePointConfig: SharePointRuntimeConfig,
    @Inject(API_SYNTHETIC_PROVIDERS_ENABLED)
    private readonly syntheticProvidersEnabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const { dataSource, schema } = this.database;
    this.connections = new PostgresConnectionRepository(dataSource, schema);
    this.documents = new PostgresDocumentRepository(dataSource, schema);
    this.workflows = new PostgresWorkflowRepository(dataSource, schema);
    this.provisioning = new PostgresWorkflowProvisioningRepository(
      dataSource,
      schema,
    );
    this.executions = new PostgresExecutionRepository(dataSource, schema);
    this.pipeline = new PostgresPipelineRepository(dataSource, schema);
    this.sessions = new PostgresUploadSessionRepository(dataSource, schema);
    this.storage = new S3ObjectStorage(this.s3Config);
    this.uploads = new DirectUploadService(this.sessions, this.storage);
    const key = {
      keyVersion: this.sharePointConfig.currentKeyVersion,
      rootKey: this.sharePointConfig.rootKey,
    };
    this.sharePointStateProtector = new AesGcmSharePointCursorProtector(
      [key],
      this.sharePointConfig.currentKeyVersion,
    );
    this.resourceBrowsers.set(
      'microsoft-sharepoint',
      new SharePointResourceBrowser(
        this.createSharePointGraph(),
        this.sharePointStateProtector,
      ),
    );
  }

  onApplicationShutdown(): void {
    this.storage?.close();
  }

  private createSharePointGraph(): SharePointGraphPort {
    if (this.sharePointConfig.graphMode === 'FAKE') {
      if (!this.syntheticProvidersEnabled) {
        throw new Error('SHAREPOINT_FAKE_GRAPH_DISABLED');
      }
      return createDemoSharePointGraphAdapter().graph;
    }
    const clientId = this.sharePointConfig.graphClientId;
    const clientSecret = this.sharePointConfig.graphClientSecret;
    if (clientId === undefined || clientSecret === undefined) {
      throw new Error('SHAREPOINT_GRAPH_ADAPTER_NOT_CONFIGURED');
    }
    const tokens = new MicrosoftEntraClientCredentialsTokenProvider(
      clientId,
      clientSecret,
      this.sharePointConfig.graphRequestTimeoutMs,
    );
    this.sharePointTokens = tokens;
    return new HttpSharePointGraphAdapter(
      new PostgresSharePointConnectionAuthority(
        this.database.dataSource,
        this.database.schema,
      ),
      tokens,
      this.sharePointConfig.graphRequestTimeoutMs,
      this.sharePointConfig.allowedDownloadHostSuffixes,
    );
  }

  connectorCatalog(capability?: string): readonly ConnectorDescriptor[] {
    if (capability === undefined) return this.connectors.descriptors();
    if (capability !== 'ENTRY' && capability !== 'DESTINATION') {
      throw new Error('CONNECTOR_CAPABILITY_INVALID');
    }
    return this.connectors.descriptorsWithCapability(capability);
  }

  connectorDescriptor(connectorId: string): ConnectorDescriptor {
    const descriptor = this.connectors.get(connectorId)?.descriptor;
    if (descriptor === undefined) throw new Error('CONNECTOR_NOT_FOUND');
    return descriptor;
  }

  extractionProfileCatalog(): readonly ExtractionProfileDescriptor[] {
    return profiles.list();
  }

  extractionProfileDescriptor(profileId: string): ExtractionProfileDescriptor {
    const profile = profiles.find(profileId);
    if (profile === undefined) throw new Error('EXTRACTION_PROFILE_NOT_FOUND');
    return profile;
  }

  async createConnection(
    authorization: ApiAuthorization,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    const input = requireRecord(body, 'CONNECTION_INPUT_INVALID');
    if (
      Object.keys(input).some(
        (key) => !['configuration', 'connectorId', 'displayName'].includes(key),
      )
    ) {
      throw new Error('CONNECTION_INPUT_INVALID');
    }
    if (typeof input.connectorId !== 'string') {
      throw new Error('CONNECTION_CONNECTOR_INVALID');
    }
    if (typeof input.displayName !== 'string') {
      throw new Error('CONNECTION_DISPLAY_NAME_INVALID');
    }
    const connector = this.connectors.get(input.connectorId);
    if (connector === undefined) throw new Error('CONNECTOR_NOT_FOUND');
    if (
      !connector.descriptor.actions.some((action) => action.connectionRequired)
    ) {
      throw new Error('CONNECTION_CONNECTOR_NOT_SUPPORTED');
    }
    const configuration =
      input.configuration === undefined
        ? {}
        : requireRecord(
            input.configuration,
            'CONNECTION_CONFIGURATION_INVALID',
          );
    const connectionValidation =
      this.connectors.validateConnectionConfiguration(
        input.connectorId,
        configuration,
      );
    if (!connectionValidation.valid) {
      throw new Error('CONNECTION_CONFIGURATION_INVALID');
    }
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const connection = await this.requireConnections().create({
      actor: authorization.actor,
      causationId: idempotencyKey,
      configuration,
      configurationSchemaVersion:
        connector.descriptor.connectionConfigurationSchemaVersion ?? 1,
      connectorId: input.connectorId,
      correlationId: authorization.correlationId,
      displayName: input.displayName,
      id: uuidFrom('connection', authorization.tenantId, idempotencyKey),
      idempotencyKey,
      tenantId: authorization.tenantId,
    });
    return connectionView(connection);
  }

  async listConnections(authorization: ApiAuthorization, connectorId?: string) {
    if (
      connectorId !== undefined &&
      this.connectors.get(connectorId) === undefined
    ) {
      throw new Error('CONNECTOR_NOT_FOUND');
    }
    const connections = await this.requireConnections().list(
      authorization.tenantId,
      connectorId,
    );
    return connections.map(connectionView);
  }

  async getConnection(authorization: ApiAuthorization, connectionId: string) {
    const connection = await this.requireConnections().findById(
      authorization.tenantId,
      connectionId,
    );
    if (connection === undefined) throw new Error('CONNECTION_NOT_FOUND');
    return connectionView(connection);
  }

  async listConnectionResources(
    authorization: ApiAuthorization,
    connectionId: string,
    query: Readonly<Record<string, unknown>>,
  ) {
    const connection = await this.requireConnections().findById(
      authorization.tenantId,
      connectionId,
    );
    if (connection === undefined || connection.status !== 'ACTIVE') {
      throw new Error('CONNECTION_NOT_FOUND');
    }
    const resourceType = query.resourceType;
    if (
      typeof resourceType !== 'string' ||
      !['DRIVE', 'FOLDER', 'SITE'].includes(resourceType) ||
      Object.keys(query).some(
        (key) =>
          ![
            'containerResourceId',
            'cursor',
            'parentResourceId',
            'resourceType',
            'search',
          ].includes(key),
      )
    ) {
      throw new Error('CONNECTION_RESOURCE_QUERY_INVALID');
    }
    const readOptional = (name: string, maximumLength: number) => {
      const value = query[name];
      if (value === undefined) return undefined;
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > maximumLength
      ) {
        throw new Error('CONNECTION_RESOURCE_QUERY_INVALID');
      }
      return value;
    };
    const browser = this.resourceBrowsers.get(connection.connectorId);
    if (browser === undefined) {
      throw new Error('CONNECTION_RESOURCE_BROWSER_NOT_CONFIGURED');
    }
    return browser.list({
      connectionId,
      ...(readOptional('containerResourceId', 512) === undefined
        ? {}
        : {
            containerResourceId: readOptional('containerResourceId', 512),
          }),
      ...(readOptional('cursor', 4_096) === undefined
        ? {}
        : { cursor: readOptional('cursor', 4_096) }),
      ...(readOptional('parentResourceId', 512) === undefined
        ? {}
        : { parentResourceId: readOptional('parentResourceId', 512) }),
      resourceType: resourceType as ConnectionResourceType,
      ...(readOptional('search', 100) === undefined
        ? {}
        : { search: readOptional('search', 100) }),
      tenantId: authorization.tenantId,
    });
  }

  async getConnectionAuthorization(
    authorization: ApiAuthorization,
    connectionId: string,
  ) {
    const connection = await this.requireSharePointConnection(
      authorization,
      connectionId,
    );
    if (this.sharePointConfig.graphMode === 'FAKE') {
      await this.requireConnections().setHealth({
        actor: authorization.actor,
        causationId: authorization.correlationId,
        connectionId,
        correlationId: authorization.correlationId,
        health: 'HEALTHY',
        tenantId: authorization.tenantId,
      });
      return { status: 'AUTHORIZED' as const };
    }
    const tokens = this.requireSharePointTokens();
    try {
      await tokens.getAccessToken({
        externalTenantId: connection.configuration.externalTenantId,
      });
      await this.requireConnections().setHealth({
        actor: authorization.actor,
        causationId: authorization.correlationId,
        connectionId,
        correlationId: authorization.correlationId,
        health: 'HEALTHY',
        tenantId: authorization.tenantId,
      });
      return { status: 'AUTHORIZED' as const };
    } catch (error) {
      if (
        error instanceof SharePointGraphError &&
        error.code === 'GRAPH_PERMISSION_DENIED'
      ) {
        await this.requireConnections().setHealth({
          actor: authorization.actor,
          causationId: authorization.correlationId,
          connectionId,
          correlationId: authorization.correlationId,
          health: 'DEGRADED',
          tenantId: authorization.tenantId,
        });
        return { status: 'CONSENT_REQUIRED' as const };
      }
      throw error;
    }
  }

  async createConnectionAuthorizationSession(
    authorization: ApiAuthorization,
    connectionId: string,
    body: unknown,
  ) {
    const connection = await this.requireSharePointConnection(
      authorization,
      connectionId,
    );
    if (this.sharePointConfig.graphMode === 'FAKE') {
      return { status: 'AUTHORIZED' as const, url: null };
    }
    const input = requireRecord(body, 'CONNECTION_AUTHORIZATION_INPUT_INVALID');
    if (
      Object.keys(input).some((key) => key !== 'redirectUri') ||
      typeof input.redirectUri !== 'string'
    ) {
      throw new Error('CONNECTION_AUTHORIZATION_INPUT_INVALID');
    }
    let redirect: URL;
    try {
      redirect = new URL(input.redirectUri);
    } catch {
      throw new Error('CONNECTION_AUTHORIZATION_REDIRECT_INVALID');
    }
    if (
      !this.sharePointConfig.allowedConsentRedirectOrigins.includes(
        redirect.origin,
      ) ||
      redirect.pathname !== '/microsoft/adminconsent/callback' ||
      redirect.username.length > 0 ||
      redirect.password.length > 0 ||
      redirect.search.length > 0 ||
      redirect.hash.length > 0
    ) {
      throw new Error('CONNECTION_AUTHORIZATION_REDIRECT_INVALID');
    }
    const state = Buffer.from(
      this.requireSharePointStateProtector().protect(
        JSON.stringify({
          connectionId,
          expiresAt: Date.now() + 10 * 60_000,
          externalTenantId: connection.configuration.externalTenantId,
          tenantId: authorization.tenantId,
        }),
      ),
    ).toString('base64url');
    return {
      status: 'CONSENT_REQUIRED' as const,
      url: this.requireSharePointTokens().adminConsentUrl({
        externalTenantId: connection.configuration.externalTenantId,
        redirectUri: redirect.toString(),
        state,
      }),
    };
  }

  async completeConnectionAuthorization(
    authorization: ApiAuthorization,
    connectionId: string,
    body: unknown,
  ) {
    const connection = await this.requireSharePointConnection(
      authorization,
      connectionId,
    );
    if (this.sharePointConfig.graphMode === 'FAKE') {
      return { status: 'AUTHORIZED' as const };
    }
    const input = requireRecord(
      body,
      'CONNECTION_AUTHORIZATION_COMPLETION_INVALID',
    );
    if (
      Object.keys(input).some(
        (key) => !['adminConsent', 'state', 'tenantId'].includes(key),
      ) ||
      input.adminConsent !== true ||
      typeof input.state !== 'string' ||
      input.state.length === 0 ||
      input.state.length > 4_096 ||
      typeof input.tenantId !== 'string'
    ) {
      throw new Error('CONNECTION_AUTHORIZATION_COMPLETION_INVALID');
    }
    let state: unknown;
    try {
      state = JSON.parse(
        this.requireSharePointStateProtector().unprotect(
          Buffer.from(input.state, 'base64url'),
        ),
      );
    } catch {
      throw new Error('CONNECTION_AUTHORIZATION_STATE_INVALID');
    }
    if (
      state === null ||
      typeof state !== 'object' ||
      !('connectionId' in state) ||
      state.connectionId !== connectionId ||
      !('tenantId' in state) ||
      state.tenantId !== authorization.tenantId ||
      !('externalTenantId' in state) ||
      state.externalTenantId !== connection.configuration.externalTenantId ||
      state.externalTenantId !== input.tenantId ||
      !('expiresAt' in state) ||
      typeof state.expiresAt !== 'number' ||
      state.expiresAt <= Date.now()
    ) {
      throw new Error('CONNECTION_AUTHORIZATION_STATE_INVALID');
    }
    await this.requireSharePointTokens().getAccessToken({
      externalTenantId: connection.configuration.externalTenantId,
    });
    await this.requireConnections().setHealth({
      actor: authorization.actor,
      causationId: authorization.correlationId,
      connectionId,
      correlationId: authorization.correlationId,
      health: 'HEALTHY',
      tenantId: authorization.tenantId,
    });
    return { status: 'AUTHORIZED' as const };
  }

  async completeConnectionAuthorizationFromState(
    authorization: ApiAuthorization,
    body: unknown,
  ) {
    const input = requireRecord(
      body,
      'CONNECTION_AUTHORIZATION_COMPLETION_INVALID',
    );
    if (typeof input.state !== 'string' || input.state.length > 4_096) {
      throw new Error('CONNECTION_AUTHORIZATION_COMPLETION_INVALID');
    }
    let state: unknown;
    try {
      state = JSON.parse(
        this.requireSharePointStateProtector().unprotect(
          Buffer.from(input.state, 'base64url'),
        ),
      );
    } catch {
      throw new Error('CONNECTION_AUTHORIZATION_STATE_INVALID');
    }
    if (
      state === null ||
      typeof state !== 'object' ||
      !('connectionId' in state) ||
      typeof state.connectionId !== 'string'
    ) {
      throw new Error('CONNECTION_AUTHORIZATION_STATE_INVALID');
    }
    return this.completeConnectionAuthorization(
      authorization,
      state.connectionId,
      body,
    );
  }

  async updateConnection(
    authorization: ApiAuthorization,
    connectionId: string,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    const input = requireRecord(body, 'CONNECTION_INPUT_INVALID');
    if (
      Object.keys(input).some(
        (key) => !['displayName', 'expectedStateVersion'].includes(key),
      )
    ) {
      throw new Error('CONNECTION_INPUT_INVALID');
    }
    if (typeof input.displayName !== 'string') {
      throw new Error('CONNECTION_DISPLAY_NAME_INVALID');
    }
    if (
      typeof input.expectedStateVersion !== 'number' ||
      !Number.isInteger(input.expectedStateVersion)
    ) {
      throw new Error('CONNECTION_STATE_VERSION_INVALID');
    }
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const connection = await this.requireConnections().update({
      actor: authorization.actor,
      causationId: idempotencyKey,
      connectionId,
      correlationId: authorization.correlationId,
      displayName: input.displayName,
      expectedStateVersion: input.expectedStateVersion,
      idempotencyKey,
      tenantId: authorization.tenantId,
    });
    return connectionView(connection);
  }

  async revokeConnection(
    authorization: ApiAuthorization,
    connectionId: string,
    rawIdempotencyKey: string | undefined,
  ) {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const connection = await this.requireConnections().revoke({
      actor: authorization.actor,
      causationId: idempotencyKey,
      connectionId,
      correlationId: authorization.correlationId,
      idempotencyKey,
      tenantId: authorization.tenantId,
    });
    return connectionView(connection);
  }

  async createWorkflow(
    authorization: ApiAuthorization,
    projectId: string,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    authorizeProject(authorization, projectId);
    const input = requireRecord(body, 'WORKFLOW_INPUT_INVALID');
    if (typeof input.name !== 'string')
      throw new Error('WORKFLOW_NAME_INVALID');
    const validation = this.validator.validate(input.definition);
    if (!validation.valid) {
      throw new Error('WORKFLOW_CONFIGURATION_INVALID');
    }
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const workflowId = uuidFrom(
      'workflow',
      authorization.tenantId,
      idempotencyKey,
    );
    const versionId = uuidFrom(
      'workflow-version',
      authorization.tenantId,
      idempotencyKey,
    );
    const result = await this.requireWorkflows().create({
      actor: authorization.actor,
      causationId: idempotencyKey,
      correlationId: authorization.correlationId,
      definition: validation.value,
      idempotencyKey,
      name: input.name,
      projectId,
      tenantId: authorization.tenantId,
      versionId,
      workflowId,
    });
    return this.workflowView(result.workflow, result.version);
  }

  async listWorkflows(authorization: ApiAuthorization, projectId: string) {
    authorizeProject(authorization, projectId);
    const workflows = await this.requireWorkflows().listByProject(
      authorization.tenantId,
      projectId,
    );
    return Promise.all(
      workflows.map(async (workflow) => {
        const version = await this.requireWorkflows().findLatestVersion(
          authorization.tenantId,
          workflow.id,
        );
        return this.workflowView(workflow, version);
      }),
    );
  }

  async getWorkflow(authorization: ApiAuthorization, workflowId: string) {
    const workflow = projectWorkflow(
      authorization,
      await this.requireWorkflows().findById(
        authorization.tenantId,
        workflowId,
      ),
    );
    const version = await this.requireWorkflows().findLatestVersion(
      authorization.tenantId,
      workflow.id,
    );
    return this.workflowView(workflow, version);
  }

  async archiveWorkflow(
    authorization: ApiAuthorization,
    workflowId: string,
    rawIdempotencyKey: string | undefined,
  ) {
    const workflow = await this.authorizeWorkflow(authorization, workflowId);
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const archived = await this.requireWorkflows().archive({
      actor: authorization.actor,
      causationId: idempotencyKey,
      correlationId: authorization.correlationId,
      idempotencyKey,
      projectId: workflow.projectId,
      tenantId: authorization.tenantId,
      workflowId,
    });
    const version = await this.requireWorkflows().findLatestVersion(
      authorization.tenantId,
      workflowId,
    );
    return this.workflowView(archived, version);
  }

  async createWorkflowVersion(
    authorization: ApiAuthorization,
    workflowId: string,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    await this.authorizeWorkflow(authorization, workflowId);
    const input = requireRecord(body, 'WORKFLOW_VERSION_INPUT_INVALID');
    if (
      typeof input.basedOnVersionId !== 'string' ||
      input.basedOnVersionId.trim().length === 0 ||
      input.basedOnVersionId.length > 256
    ) {
      throw new Error('WORKFLOW_VERSION_BASE_INVALID');
    }
    const validation = this.validator.validate(input.definition);
    if (!validation.valid) {
      throw new Error('WORKFLOW_CONFIGURATION_INVALID');
    }
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const version = await this.requireWorkflows().createVersion({
      actor: authorization.actor,
      basedOnVersionId: input.basedOnVersionId.trim(),
      causationId: idempotencyKey,
      correlationId: authorization.correlationId,
      definition: validation.value,
      idempotencyKey,
      tenantId: authorization.tenantId,
      versionId: uuidFrom(
        'workflow-version-edit',
        authorization.tenantId,
        idempotencyKey,
      ),
      workflowId,
    });
    return workflowVersionView(version);
  }

  async listWorkflowVersions(
    authorization: ApiAuthorization,
    workflowId: string,
  ) {
    await this.authorizeWorkflow(authorization, workflowId);
    const versions = await this.requireWorkflows().listVersions(
      authorization.tenantId,
      workflowId,
    );
    return versions.map(workflowVersionView);
  }

  async getWorkflowVersion(
    authorization: ApiAuthorization,
    workflowId: string,
    versionId: string,
  ) {
    await this.authorizeWorkflow(authorization, workflowId);
    const version = await this.requireWorkflows().findVersionById(
      authorization.tenantId,
      workflowId,
      versionId,
    );
    if (version === undefined) {
      throw new Error('WORKFLOW_VERSION_NOT_FOUND');
    }
    return workflowVersionView(version);
  }

  async activateWorkflow(
    authorization: ApiAuthorization,
    workflowId: string,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    const workflow = projectWorkflow(
      authorization,
      await this.requireWorkflows().findById(
        authorization.tenantId,
        workflowId,
      ),
    );
    const input = requireRecord(body, 'WORKFLOW_ACTIVATION_INPUT_INVALID');
    if (typeof input.versionId !== 'string') {
      throw new Error('WORKFLOW_VERSION_NOT_FOUND');
    }
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const operation = await this.requireProvisioning().requestActivation({
      actor: authorization.actor,
      causationId: idempotencyKey,
      correlationId: authorization.correlationId,
      idempotencyKey,
      operationId: uuidFrom(
        'workflow-activation',
        authorization.tenantId,
        idempotencyKey,
      ),
      projectId: workflow.projectId,
      targetVersionId: input.versionId,
      tenantId: authorization.tenantId,
      workflowId,
    });
    return provisioningOperationView(operation, workflow.activeVersionId);
  }

  async getActivation(authorization: ApiAuthorization, workflowId: string) {
    const workflow = await this.authorizeWorkflow(authorization, workflowId);
    const operation = await this.requireProvisioning().findCurrentByWorkflow(
      authorization.tenantId,
      workflowId,
    );
    return activationView(workflow, operation);
  }

  async deactivateWorkflow(
    authorization: ApiAuthorization,
    workflowId: string,
    rawIdempotencyKey: string | undefined,
  ) {
    const workflow = await this.authorizeWorkflow(authorization, workflowId);
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const result = await this.requireProvisioning().requestDeactivation({
      actor: authorization.actor,
      causationId: idempotencyKey,
      correlationId: authorization.correlationId,
      idempotencyKey,
      operationId: uuidFrom(
        'workflow-deactivation',
        authorization.tenantId,
        idempotencyKey,
      ),
      projectId: workflow.projectId,
      tenantId: authorization.tenantId,
      workflowId,
    });
    const operation =
      result.operationId === undefined
        ? undefined
        : await this.requireProvisioning().findById(
            authorization.tenantId,
            result.operationId,
          );
    return deactivationView(result, operation);
  }

  async getOperation(authorization: ApiAuthorization, operationId: string) {
    const operation = await this.requireProvisioning().findById(
      authorization.tenantId,
      operationId,
    );
    if (operation === undefined)
      throw new Error('PROVISIONING_OPERATION_NOT_FOUND');
    authorizeProject(authorization, operation.projectId);
    const workflow = await this.requireWorkflows().findById(
      authorization.tenantId,
      operation.workflowId,
    );
    if (workflow === undefined) {
      throw new Error('WORKFLOW_NOT_FOUND');
    }
    return provisioningOperationView(operation, workflow.activeVersionId);
  }

  async createUpload(
    authorization: ApiAuthorization,
    workflowId: string,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    const workflow = projectWorkflow(
      authorization,
      await this.requireWorkflows().findById(
        authorization.tenantId,
        workflowId,
      ),
    );
    const input = requireRecord(body, 'UPLOAD_SESSION_INPUT_INVALID');
    const checksum = requireRecord(
      input.checksum,
      'UPLOAD_SESSION_CHECKSUM_INVALID',
    );
    if (
      typeof input.originalFilename !== 'string' ||
      typeof input.contentType !== 'string' ||
      typeof input.sizeBytes !== 'number' ||
      checksum.algorithm !== 'SHA256' ||
      typeof checksum.value !== 'string'
    ) {
      throw new Error('UPLOAD_SESSION_INPUT_INVALID');
    }
    return this.requireUploads().create({
      actor: authorization.actor,
      causationId: authorization.correlationId,
      clientChecksumValue: checksum.value,
      contentType: input.contentType,
      correlationId: authorization.correlationId,
      idempotencyKey: requireIdempotencyKey(rawIdempotencyKey),
      originalFilename: input.originalFilename,
      projectId: workflow.projectId,
      sizeBytes: input.sizeBytes,
      tenantId: authorization.tenantId,
      workflowId,
    });
  }

  async issuePart(
    authorization: ApiAuthorization,
    uploadSessionId: string,
    partNumber: number,
    body: unknown,
  ) {
    await this.authorizeSession(authorization, uploadSessionId);
    const input = requireRecord(body, 'UPLOAD_PART_INPUT_INVALID');
    if (
      typeof input.checksumValue !== 'string' ||
      typeof input.contentLength !== 'number'
    ) {
      throw new Error('UPLOAD_PART_INPUT_INVALID');
    }
    return this.requireUploads().issueMultipartPartCapability({
      actor: authorization.actor,
      causationId: authorization.correlationId,
      checksumValue: input.checksumValue,
      contentLength: input.contentLength,
      correlationId: authorization.correlationId,
      partNumber,
      tenantId: authorization.tenantId,
      uploadSessionId,
    });
  }

  async completeUpload(
    authorization: ApiAuthorization,
    uploadSessionId: string,
    body: unknown,
    rawIdempotencyKey: string | undefined,
  ) {
    await this.authorizeSession(authorization, uploadSessionId);
    const input = requireRecord(body, 'UPLOAD_COMPLETION_INPUT_INVALID');
    const parts = input.parts;
    if (parts !== undefined && !Array.isArray(parts)) {
      throw new Error('UPLOAD_COMPLETION_PARTS_INVALID');
    }
    return this.requireUploads().complete({
      actor: authorization.actor,
      causationId: authorization.correlationId,
      correlationId: authorization.correlationId,
      idempotencyKey: requireIdempotencyKey(rawIdempotencyKey),
      ...(parts === undefined
        ? {}
        : { parts: parts as readonly MultipartCompletionReceipt[] }),
      tenantId: authorization.tenantId,
      uploadSessionId,
    });
  }

  async abortUpload(authorization: ApiAuthorization, uploadSessionId: string) {
    const session = await this.authorizeSession(authorization, uploadSessionId);
    if (session.status !== 'ACTIVE') return session;
    if (session.multipartUploadReference !== undefined) {
      await this.requireStorage().abortMultipartUpload({
        storageObjectId: session.storageObjectId,
        tenantId: authorization.tenantId,
        uploadReference: session.multipartUploadReference,
      });
    } else {
      const object = await this.requireStorage().inspectUpload({
        storageObjectId: session.storageObjectId,
        tenantId: authorization.tenantId,
      });
      if (object !== undefined) {
        await this.requireStorage().deleteExactVersion({
          key: object.key,
          versionId: object.versionId,
        });
      }
    }
    return this.requireSessions().abort({
      actor: authorization.actor,
      causationId: authorization.correlationId,
      correlationId: authorization.correlationId,
      expectedStateVersion: session.stateVersion,
      tenantId: authorization.tenantId,
      uploadSessionId,
    });
  }

  async getExecution(authorization: ApiAuthorization, executionId: string) {
    const execution = await this.requireExecutions().findById(
      authorization.tenantId,
      executionId,
    );
    if (execution === undefined) throw new Error('EXECUTION_NOT_FOUND');
    authorizeProject(authorization, execution.projectId);
    return {
      ...(await this.executionView(authorization.tenantId, execution)),
      auditTrail: await this.requireExecutions().listAuditEvents(
        authorization.tenantId,
        executionId,
      ),
    };
  }

  async listExecutions(authorization: ApiAuthorization, workflowId: string) {
    await this.getWorkflow(authorization, workflowId);
    const executions = await this.requireExecutions().listByWorkflow(
      authorization.tenantId,
      workflowId,
    );
    return Promise.all(
      executions.map((execution) =>
        this.executionView(authorization.tenantId, execution),
      ),
    );
  }

  async retryExecution(
    authorization: ApiAuthorization,
    executionId: string,
    rawIdempotencyKey: string | undefined,
  ) {
    const original = await this.requireExecutions().findById(
      authorization.tenantId,
      executionId,
    );
    if (original === undefined) throw new Error('EXECUTION_NOT_FOUND');
    authorizeProject(authorization, original.projectId);
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const execution = await this.requireExecutions().retry({
      actor: authorization.actor,
      causationId: idempotencyKey,
      correlationId: authorization.correlationId,
      executionId,
      idempotencyKey,
      retryExecutionId: uuidFrom(
        'execution-retry',
        authorization.tenantId,
        idempotencyKey,
      ),
      tenantId: authorization.tenantId,
    });
    return this.executionView(authorization.tenantId, execution);
  }

  async acceptExtractionCallback(
    body: Buffer,
    signature: string | undefined,
    timestamp: string | undefined,
  ) {
    if (signature === undefined || timestamp === undefined) {
      throw new Error('EXTRACTION_CALLBACK_UNAUTHENTICATED');
    }
    const callback = verifyExtractionCallback({
      body,
      now: new Date(),
      secret: 'aiflow-demo-callback-secret',
      signature,
      timestamp,
    });
    return this.requirePipeline().acceptExtractionCallback({
      adapterId: 'fake-extraction',
      bodySha256: createHash('sha256').update(body).digest('hex'),
      callbackCorrelationId: callback.callbackCorrelationId,
      providerEventId: callback.eventId,
      safeStatus: callback.status,
    });
  }

  private async authorizeSession(
    authorization: ApiAuthorization,
    uploadSessionId: string,
  ) {
    const session = await this.requireSessions().findById(
      authorization.tenantId,
      uploadSessionId,
    );
    if (session === undefined) throw new Error('UPLOAD_SESSION_NOT_FOUND');
    authorizeProject(authorization, session.projectId);
    return session;
  }

  private async authorizeWorkflow(
    authorization: ApiAuthorization,
    workflowId: string,
  ) {
    return projectWorkflow(
      authorization,
      await this.requireWorkflows().findById(
        authorization.tenantId,
        workflowId,
      ),
    );
  }

  private workflowView(
    workflow: WorkflowRecord,
    version?: {
      id: string;
      versionNumber: number;
      definition: { definition: WorkflowDefinitionV1 };
    },
  ) {
    return {
      acceptingNewDocuments: workflow.acceptingNewDocuments,
      activeVersionId: workflow.activeVersionId ?? null,
      cleanupRequired: workflow.cleanupRequired,
      createdAt: workflow.createdAt,
      health: workflow.health,
      id: workflow.id,
      latestVersion:
        version === undefined
          ? null
          : {
              definition: version.definition.definition,
              id: version.id,
              schemaVersion: 1,
              status: 'VALID',
              versionNumber: version.versionNumber,
            },
      name: workflow.name,
      projectId: workflow.projectId,
      status: workflow.status,
      updatedAt: workflow.updatedAt,
    };
  }

  private async executionView(tenantId: string, execution: ExecutionRecord) {
    const document = await this.requireDocuments().findById(
      tenantId,
      execution.documentId,
    );
    return executionView(execution, document?.originalFilename);
  }

  private requireDocuments() {
    if (!this.documents) throw new Error('API_NOT_READY');
    return this.documents;
  }
  private requireExecutions() {
    if (!this.executions) throw new Error('API_NOT_READY');
    return this.executions;
  }
  private requireConnections() {
    if (!this.connections) throw new Error('API_NOT_READY');
    return this.connections;
  }
  private async requireSharePointConnection(
    authorization: ApiAuthorization,
    connectionId: string,
  ): Promise<
    ConnectionRecord & {
      readonly configuration: {
        readonly externalTenantId: string;
        readonly identityMode: 'SAAS_MULTITENANT';
        readonly permissionProfile: 'FILES_AND_SITES_READ_ALL_V1';
      };
    }
  > {
    const connection = await this.requireConnections().findById(
      authorization.tenantId,
      connectionId,
    );
    if (
      connection === undefined ||
      connection.connectorId !== 'microsoft-sharepoint' ||
      connection.status !== 'ACTIVE' ||
      !isSharePointConnectionConfiguration(connection.configuration)
    ) {
      throw new Error('CONNECTION_NOT_FOUND');
    }
    return { ...connection, configuration: connection.configuration };
  }
  private requireSharePointStateProtector(): SharePointCursorProtector {
    if (this.sharePointStateProtector === undefined) {
      throw new Error('API_NOT_READY');
    }
    return this.sharePointStateProtector;
  }
  private requireSharePointTokens(): MicrosoftEntraClientCredentialsTokenProvider {
    if (this.sharePointTokens === undefined) {
      throw new Error('SHAREPOINT_GRAPH_ADAPTER_NOT_CONFIGURED');
    }
    return this.sharePointTokens;
  }
  private requirePipeline() {
    if (!this.pipeline) throw new Error('API_NOT_READY');
    return this.pipeline;
  }
  private requireProvisioning() {
    if (!this.provisioning) throw new Error('API_NOT_READY');
    return this.provisioning;
  }
  private requireSessions() {
    if (!this.sessions) throw new Error('API_NOT_READY');
    return this.sessions;
  }
  private requireStorage() {
    if (!this.storage) throw new Error('API_NOT_READY');
    return this.storage;
  }
  private requireUploads() {
    if (!this.uploads) throw new Error('API_NOT_READY');
    return this.uploads;
  }
  private requireWorkflows() {
    if (!this.workflows) throw new Error('API_NOT_READY');
    return this.workflows;
  }
}
