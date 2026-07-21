import type { ConnectorRegistry } from '@aiflow/connector-sdk';

import type {
  ProvisioningOperationRecord,
  WorkflowProvisioningRepository,
  WorkflowRepository,
} from './ports';

export class WorkflowProvisioningService {
  constructor(
    private readonly operations: WorkflowProvisioningRepository,
    private readonly workflows: WorkflowRepository,
    private readonly connectors: ConnectorRegistry,
  ) {}

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
    if (
      operation === undefined ||
      operation.targetVersionId === undefined ||
      operation.kind !== 'ACTIVATE'
    ) {
      return operation;
    }

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

    await Promise.all([
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

    return this.operations.completeActivation({
      expectedStateVersion: operation.stateVersion,
      leaseOwner: input.leaseOwner,
      operationId: operation.id,
      tenantId: operation.tenantId,
    });
  }
}
