import { ConnectorRegistry } from '@aiflow/connector-sdk';

import type {
  ManagedEntryProvisioner,
  ProvisioningOperationRecord,
  WorkflowProvisioningRepository,
  WorkflowRepository,
} from './ports';
import { WorkflowProvisioningService } from './provisioning';

const operation: ProvisioningOperationRecord = {
  actor: { id: 'user-1', type: 'USER' },
  attemptCount: 1,
  causationId: 'activate-1',
  correlationId: 'correlation-1',
  createdAt: new Date('2026-07-23T00:00:00.000Z'),
  currentStep: 'VALIDATE',
  id: 'operation-1',
  kind: 'ACTIVATE',
  projectId: 'project-1',
  stateVersion: 1,
  status: 'RUNNING',
  targetVersionId: 'version-1',
  tenantId: 'tenant-1',
  updatedAt: new Date('2026-07-23T00:00:00.000Z'),
  workflowId: 'workflow-1',
};

const version = {
  createdAt: new Date('2026-07-23T00:00:00.000Z'),
  createdBy: { id: 'user-1', type: 'USER' as const },
  definition: {
    connectionReferences: [
      { connectionId: 'connection-1', purpose: 'ENTRY' as const },
    ],
    definition: {
      destination: {
        actionId: 'complete',
        config: {},
        connectorId: 'destination',
      },
      entry: {
        config: { folderId: 'folder-1' },
        connectionId: 'connection-1',
        connectorId: 'managed-entry',
      },
      extraction: { config: {}, profileId: 'profile-1' },
      mappings: [],
      reviewPolicy: { required: false },
      schemaVersion: 1 as const,
    },
    definitionHash: 'a'.repeat(64),
    profileReference: {
      outputSchemaHash: 'b'.repeat(64),
      profileId: 'profile-1',
      profileKind: 'SYSTEM' as const,
      profileVersionId: 'profile-version-1',
    },
  },
  id: 'version-1',
  tenantId: 'tenant-1',
  versionNumber: 1,
  workflowId: 'workflow-1',
};

const registry = new ConnectorRegistry([
  {
    descriptor: {
      actions: [
        {
          actionId: 'watch',
          capability: 'ENTRY',
          connectionRequired: true,
          configurationSchema: { type: 'object' },
          configurationSchemaVersion: 1,
          displayName: 'Watch',
          provisioningMode: 'MANAGED',
          version: 1,
        },
      ],
      connectorId: 'managed-entry',
      displayName: 'Managed entry',
      version: 1,
    },
    validateActivation: async () => ({
      capabilityHash: 'c'.repeat(64),
      status: 'READY',
    }),
  },
  {
    descriptor: {
      actions: [
        {
          actionId: 'complete',
          capability: 'DESTINATION',
          connectionRequired: false,
          configurationSchema: { type: 'object' },
          configurationSchemaVersion: 1,
          displayName: 'Complete',
          provisioningMode: 'NONE',
          version: 1,
        },
      ],
      connectorId: 'destination',
      displayName: 'Destination',
      version: 1,
    },
    validateActivation: async () => ({
      capabilityHash: 'd'.repeat(64),
      status: 'READY',
    }),
  },
]);

const input = {
  consumerName: 'worker-1',
  expectedStateVersion: 0,
  leaseDurationMs: 30_000,
  leaseOwner: 'worker-1',
  messageId: 'message-1',
  messageType: 'aiflow.workflow.provisioning.requested.v1',
  operationId: 'operation-1',
  projectId: 'project-1',
  tenantId: 'tenant-1',
};

const setup = (provisioner: ManagedEntryProvisioner) => {
  const operations = {
    claim: jest.fn().mockResolvedValue(operation),
    completeActivation: jest
      .fn()
      .mockResolvedValue({ ...operation, status: 'SUCCEEDED' }),
    deferActivation: jest
      .fn()
      .mockResolvedValue({ ...operation, status: 'WAITING_RETRY' }),
    completeDeactivation: jest
      .fn()
      .mockResolvedValue({ ...operation, status: 'SUCCEEDED' }),
    deferDeactivation: jest
      .fn()
      .mockResolvedValue({ ...operation, status: 'WAITING_RETRY' }),
  } as unknown as jest.Mocked<WorkflowProvisioningRepository>;
  const workflows = {
    findVersionById: jest.fn().mockResolvedValue(version),
  } as unknown as jest.Mocked<WorkflowRepository>;
  return {
    operations,
    service: new WorkflowProvisioningService(operations, workflows, registry, [
      provisioner,
    ]),
  };
};

describe('managed entry provisioning', () => {
  it('durably defers activation when bounded provider work remains', async () => {
    const retryAt = new Date('2026-07-23T00:00:05.000Z');
    const provisioner = {
      connectorId: 'managed-entry',
      prepare: jest.fn().mockResolvedValue({ retryAt, status: 'PENDING' }),
      remove: jest.fn().mockResolvedValue({ status: 'READY' }),
    } satisfies ManagedEntryProvisioner;
    const { operations, service } = setup(provisioner);

    await expect(service.processActivation(input)).resolves.toMatchObject({
      status: 'WAITING_RETRY',
    });
    expect(operations.deferActivation).toHaveBeenCalledWith({
      expectedStateVersion: 1,
      leaseOwner: 'worker-1',
      nextAttemptAt: retryAt,
      operationId: 'operation-1',
      tenantId: 'tenant-1',
    });
    expect(operations.completeActivation).not.toHaveBeenCalled();
  });

  it('switches active only with the ready managed binding', async () => {
    const provisioner = {
      connectorId: 'managed-entry',
      prepare: jest
        .fn()
        .mockResolvedValue({ bindingId: 'binding-1', status: 'READY' }),
      remove: jest.fn().mockResolvedValue({ status: 'READY' }),
    } satisfies ManagedEntryProvisioner;
    const { operations, service } = setup(provisioner);

    await service.processActivation(input);

    expect(operations.completeActivation).toHaveBeenCalledWith({
      expectedStateVersion: 1,
      leaseOwner: 'worker-1',
      managedBindingId: 'binding-1',
      operationId: 'operation-1',
      tenantId: 'tenant-1',
    });
  });

  it('durably removes the managed entry before completing deactivation', async () => {
    const deactivation = {
      ...operation,
      kind: 'DEACTIVATE' as const,
      previousVersionId: 'version-1',
      targetVersionId: undefined,
    };
    const retryAt = new Date('2026-07-23T00:00:05.000Z');
    const provisioner = {
      connectorId: 'managed-entry',
      prepare: jest.fn(),
      remove: jest.fn().mockResolvedValue({ retryAt, status: 'PENDING' }),
    } satisfies ManagedEntryProvisioner;
    const { operations, service } = setup(provisioner);
    operations.claim.mockResolvedValue(deactivation);

    await service.processActivation(input);

    expect(provisioner.remove).toHaveBeenCalledWith({
      operationId: 'operation-1',
      projectId: 'project-1',
      tenantId: 'tenant-1',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
    });
    expect(operations.deferDeactivation).toHaveBeenCalledWith({
      expectedStateVersion: 1,
      leaseOwner: 'worker-1',
      nextAttemptAt: retryAt,
      operationId: 'operation-1',
      tenantId: 'tenant-1',
    });
    expect(operations.completeDeactivation).not.toHaveBeenCalled();
  });
});
