import type { ActorIdentity } from '@aiflow/core';

import type { ValidatedWorkflowDefinition } from './definition';

export interface WorkflowRecord {
  readonly acceptingNewDocuments: boolean;
  readonly activeVersionId?: string;
  readonly cleanupRequired: boolean;
  readonly createdAt: Date;
  readonly health: 'DEGRADED' | 'HEALTHY' | 'UNKNOWN';
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly stateVersion: number;
  readonly status: 'ACTIVE' | 'ARCHIVED' | 'INACTIVE';
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface WorkflowVersionRecord {
  readonly createdAt: Date;
  readonly createdBy: ActorIdentity;
  readonly definition: ValidatedWorkflowDefinition;
  readonly id: string;
  readonly tenantId: string;
  readonly versionNumber: number;
  readonly workflowId: string;
}

export interface CreateWorkflowInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly definition: ValidatedWorkflowDefinition;
  readonly idempotencyKey?: string;
  readonly name: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly versionId: string;
  readonly workflowId: string;
}

export interface CreateWorkflowVersionInput {
  readonly actor: ActorIdentity;
  readonly basedOnVersionId: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly definition: ValidatedWorkflowDefinition;
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly versionId: string;
  readonly workflowId: string;
}

export interface ArchiveWorkflowInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly workflowId: string;
}

export interface WorkflowRepository {
  archive(input: ArchiveWorkflowInput): Promise<WorkflowRecord>;
  create(input: CreateWorkflowInput): Promise<{
    readonly version: WorkflowVersionRecord;
    readonly workflow: WorkflowRecord;
  }>;
  createVersion(
    input: CreateWorkflowVersionInput,
  ): Promise<WorkflowVersionRecord>;
  findById(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowRecord | undefined>;
  findVersionById(
    tenantId: string,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersionRecord | undefined>;
  findLatestVersion(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowVersionRecord | undefined>;
  listVersions(
    tenantId: string,
    workflowId: string,
    limit?: number,
  ): Promise<readonly WorkflowVersionRecord[]>;
  listByProject(
    tenantId: string,
    projectId: string,
    limit?: number,
  ): Promise<readonly WorkflowRecord[]>;
}

export type ProvisioningOperationStatus =
  | 'FAILED'
  | 'PENDING'
  | 'RECONCILING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'WAITING_RETRY';

export interface ProvisioningOperationRecord {
  readonly actor: ActorIdentity;
  readonly attemptCount: number;
  readonly causationId: string;
  readonly completedAt?: Date;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly currentStep:
    'DEPROVISION' | 'PROVISION' | 'RECONCILE' | 'SWITCH' | 'VALIDATE';
  readonly definitionHash?: string;
  readonly id: string;
  readonly kind: 'ACTIVATE' | 'DEACTIVATE';
  readonly previousVersionId?: string;
  readonly projectId: string;
  readonly stateVersion: number;
  readonly status: ProvisioningOperationStatus;
  readonly targetVersionId?: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly workflowId: string;
}

export interface RequestWorkflowActivationInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly targetVersionId: string;
  readonly tenantId: string;
  readonly workflowId: string;
}

export interface RequestWorkflowDeactivationInput {
  readonly actor: ActorIdentity;
  readonly causationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly workflowId: string;
}

export interface WorkflowDeactivationResult {
  readonly acceptingNewDocuments: boolean;
  readonly activeVersionId?: string;
  readonly cleanupRequired: boolean;
  readonly health: WorkflowRecord['health'];
  readonly operationId?: string;
  readonly workflowId: string;
}

export interface ClaimProvisioningOperationInput {
  readonly consumerName: string;
  readonly expectedStateVersion: number;
  readonly leaseDurationMs: number;
  readonly leaseOwner: string;
  readonly messageId: string;
  readonly messageType: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly tenantId: string;
}

export interface WorkflowProvisioningRepository {
  claim(
    input: ClaimProvisioningOperationInput,
  ): Promise<ProvisioningOperationRecord | undefined>;
  completeActivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly managedBindingId?: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord>;
  deferActivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord>;
  completeDeactivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord>;
  deferDeactivation(input: {
    readonly expectedStateVersion: number;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly operationId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord>;
  findById(
    tenantId: string,
    operationId: string,
  ): Promise<ProvisioningOperationRecord | undefined>;
  findCurrentByWorkflow(
    tenantId: string,
    workflowId: string,
  ): Promise<ProvisioningOperationRecord | undefined>;
  requestActivation(
    input: RequestWorkflowActivationInput,
  ): Promise<ProvisioningOperationRecord>;
  requestDeactivation(
    input: RequestWorkflowDeactivationInput,
  ): Promise<WorkflowDeactivationResult>;
}

export type ManagedEntryProvisioningResult =
  | {
      readonly bindingId: string;
      readonly status: 'READY';
    }
  | {
      readonly retryAt: Date;
      readonly status: 'PENDING';
    };

export interface ManagedEntryProvisioner {
  readonly connectorId: string;
  prepare(input: {
    readonly actionId: string;
    readonly capabilityHash: string;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly connectionId: string;
    readonly operationId: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
  }): Promise<ManagedEntryProvisioningResult>;
  remove(input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
  }): Promise<
    | { readonly status: 'READY' }
    | { readonly retryAt: Date; readonly status: 'PENDING' }
  >;
}
