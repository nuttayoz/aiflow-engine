import type { ConnectorRegistry } from '@aiflow/connector-sdk';

import type {
  ManagedEntryProvisioner,
  ProvisioningOperationRecord,
  WorkflowProvisioningRepository,
  WorkflowRepository,
} from './ports';

export class WorkflowProvisioningService {
  private readonly managedEntryProvisioners: ReadonlyMap<
    string,
    ManagedEntryProvisioner
  >;

  constructor(
    private readonly operations: WorkflowProvisioningRepository,
    private readonly workflows: WorkflowRepository,
    private readonly connectors: ConnectorRegistry,
    managedEntryProvisioners: readonly ManagedEntryProvisioner[] = [],
  ) {
    this.managedEntryProvisioners = new Map(
      managedEntryProvisioners.map((provisioner) => [
        provisioner.connectorId,
        provisioner,
      ]),
    );
    if (
      this.managedEntryProvisioners.size !== managedEntryProvisioners.length
    ) {
      throw new Error('MANAGED_CONNECTOR_PROVISIONER_DUPLICATE');
    }
  }

  async processActivation(input: {
    readonly consumerName: string;
    readonly expectedStateVersion: number;
    readonly leaseDurationMs: number;
    readonly leaseOwner: string;
    readonly messageId: string;
    readonly messageType: string;
    readonly operationId: string;
    readonly projectId: string;
    readonly tenantId: string;
  }): Promise<ProvisioningOperationRecord | undefined> {
    const operation = await this.operations.claim(input);
    if (operation === undefined) {
      return operation;
    }
    if (operation.kind === 'DEACTIVATE') {
      return this.processDeactivation(operation, input.leaseOwner);
    }
    if (operation.targetVersionId === undefined) return operation;

    const version = await this.workflows.findVersionById(
      operation.tenantId,
      operation.workflowId,
      operation.targetVersionId,
    );
    if (version === undefined) {
      throw new Error('WORKFLOW_VERSION_NOT_FOUND');
    }

    const entryConnector = this.connectors.get(
      version.definition.definition.entry.connectorId,
    );
    const destinationConnector = this.connectors.get(
      version.definition.definition.destination.connectorId,
    );
    const entryAction = entryConnector?.descriptor.actions.find(
      (action) => action.capability === 'ENTRY',
    );
    if (
      entryConnector === undefined ||
      destinationConnector === undefined ||
      entryAction === undefined
    ) {
      throw new Error('CONNECTOR_NOT_INSTALLED');
    }

    const [entryActivation] = await Promise.all([
      entryConnector.validateActivation({
        actionId: entryAction.actionId,
        configuration: version.definition.definition.entry.config,
        ...(version.definition.definition.entry.connectionId === undefined
          ? {}
          : {
              connectionId: version.definition.definition.entry.connectionId,
            }),
        projectId: operation.projectId,
        tenantId: operation.tenantId,
      }),
      destinationConnector.validateActivation({
        actionId: version.definition.definition.destination.actionId,
        configuration: version.definition.definition.destination.config,
        ...(version.definition.definition.destination.connectionId === undefined
          ? {}
          : {
              connectionId:
                version.definition.definition.destination.connectionId,
            }),
        projectId: operation.projectId,
        tenantId: operation.tenantId,
      }),
    ]);

    let managedBindingId: string | undefined;
    if (entryAction.provisioningMode === 'MANAGED') {
      const connectionId = version.definition.definition.entry.connectionId;
      if (connectionId === undefined) {
        throw new Error('MANAGED_CONNECTOR_CONNECTION_REQUIRED');
      }
      const provisioner = this.managedEntryProvisioners.get(
        entryConnector.descriptor.connectorId,
      );
      if (provisioner === undefined) {
        throw new Error('MANAGED_CONNECTOR_PROVISIONER_NOT_INSTALLED');
      }
      const result = await provisioner.prepare({
        actionId: entryAction.actionId,
        capabilityHash: entryActivation.capabilityHash,
        configuration: version.definition.definition.entry.config,
        connectionId,
        operationId: operation.id,
        projectId: operation.projectId,
        tenantId: operation.tenantId,
        workflowId: operation.workflowId,
        workflowVersionId: version.id,
      });
      if (result.status === 'PENDING') {
        return this.operations.deferActivation({
          expectedStateVersion: operation.stateVersion,
          leaseOwner: input.leaseOwner,
          nextAttemptAt: result.retryAt,
          operationId: operation.id,
          tenantId: operation.tenantId,
        });
      }
      managedBindingId = result.bindingId;
    }

    if (
      operation.previousVersionId !== undefined &&
      operation.previousVersionId !== operation.targetVersionId
    ) {
      const previous = await this.workflows.findVersionById(
        operation.tenantId,
        operation.workflowId,
        operation.previousVersionId,
      );
      if (previous === undefined) throw new Error('WORKFLOW_VERSION_NOT_FOUND');
      const previousConnectorId =
        previous.definition.definition.entry.connectorId;
      const previousConnector = this.connectors.get(previousConnectorId);
      const previousAction = previousConnector?.descriptor.actions.find(
        (action) => action.capability === 'ENTRY',
      );
      if (
        previousConnector !== undefined &&
        previousAction?.provisioningMode === 'MANAGED'
      ) {
        const previousProvisioner =
          this.managedEntryProvisioners.get(previousConnectorId);
        if (previousProvisioner === undefined) {
          throw new Error('MANAGED_CONNECTOR_PROVISIONER_NOT_INSTALLED');
        }
        const removal = await previousProvisioner.remove({
          operationId: operation.id,
          projectId: operation.projectId,
          tenantId: operation.tenantId,
          workflowId: operation.workflowId,
          workflowVersionId: previous.id,
        });
        if (removal.status === 'PENDING') {
          return this.operations.deferActivation({
            expectedStateVersion: operation.stateVersion,
            leaseOwner: input.leaseOwner,
            nextAttemptAt: removal.retryAt,
            operationId: operation.id,
            tenantId: operation.tenantId,
          });
        }
      }
    }

    return this.operations.completeActivation({
      expectedStateVersion: operation.stateVersion,
      leaseOwner: input.leaseOwner,
      ...(managedBindingId === undefined ? {} : { managedBindingId }),
      operationId: operation.id,
      tenantId: operation.tenantId,
    });
  }

  private async processDeactivation(
    operation: ProvisioningOperationRecord,
    leaseOwner: string,
  ): Promise<ProvisioningOperationRecord> {
    if (operation.previousVersionId === undefined) {
      return this.operations.completeDeactivation({
        expectedStateVersion: operation.stateVersion,
        leaseOwner,
        operationId: operation.id,
        tenantId: operation.tenantId,
      });
    }
    const version = await this.workflows.findVersionById(
      operation.tenantId,
      operation.workflowId,
      operation.previousVersionId,
    );
    if (version === undefined) throw new Error('WORKFLOW_VERSION_NOT_FOUND');
    const connectorId = version.definition.definition.entry.connectorId;
    const connector = this.connectors.get(connectorId);
    const action = connector?.descriptor.actions.find(
      (candidate) => candidate.capability === 'ENTRY',
    );
    if (connector === undefined || action === undefined) {
      throw new Error('CONNECTOR_NOT_INSTALLED');
    }
    if (action.provisioningMode === 'MANAGED') {
      const provisioner = this.managedEntryProvisioners.get(connectorId);
      if (provisioner === undefined) {
        throw new Error('MANAGED_CONNECTOR_PROVISIONER_NOT_INSTALLED');
      }
      const result = await provisioner.remove({
        operationId: operation.id,
        projectId: operation.projectId,
        tenantId: operation.tenantId,
        workflowId: operation.workflowId,
        workflowVersionId: version.id,
      });
      if (result.status === 'PENDING') {
        return this.operations.deferDeactivation({
          expectedStateVersion: operation.stateVersion,
          leaseOwner,
          nextAttemptAt: result.retryAt,
          operationId: operation.id,
          tenantId: operation.tenantId,
        });
      }
    }
    return this.operations.completeDeactivation({
      expectedStateVersion: operation.stateVersion,
      leaseOwner,
      operationId: operation.id,
      tenantId: operation.tenantId,
    });
  }
}
