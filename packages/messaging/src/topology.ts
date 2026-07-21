export const COMMAND_EXCHANGE = 'aiflow.commands.v1';
export const DEAD_LETTER_EXCHANGE = 'aiflow.dlx.v1';

export interface QueueBinding {
  readonly bindingKeys: readonly string[];
  readonly name: string;
}

export const CORE_QUEUE_BINDINGS: readonly QueueBinding[] = [
  {
    bindingKeys: [
      'execution.stage.extract.requested.v1',
      'extraction.provider-copy.delete.requested.v1',
    ],
    name: 'aiflow.q.stage.extract.v1',
  },
  {
    bindingKeys: ['execution.stage.map.requested.v1'],
    name: 'aiflow.q.stage.map.v1',
  },
  {
    bindingKeys: [
      'execution.stage.review.requested.v1',
      'review.provider-copy.delete.requested.v1',
    ],
    name: 'aiflow.q.stage.review.v1',
  },
  {
    bindingKeys: ['execution.stage.reconcile.requested.v1'],
    name: 'aiflow.q.stage.reconcile.v1',
  },
  {
    bindingKeys: ['storage.object.*.requested.v1'],
    name: 'aiflow.q.storage.lifecycle.v1',
  },
  {
    bindingKeys: ['workflow.provisioning.requested.v1'],
    name: 'aiflow.q.workflow.provisioning.v1',
  },
] as const;

export const queueNameForSelection = (selection: string): string | undefined =>
  ({
    extract: 'aiflow.q.stage.extract.v1',
    map: 'aiflow.q.stage.map.v1',
    provisioning: 'aiflow.q.workflow.provisioning.v1',
    reconcile: 'aiflow.q.stage.reconcile.v1',
    review: 'aiflow.q.stage.review.v1',
    storage: 'aiflow.q.storage.lifecycle.v1',
  })[selection];

export const deadLetterQueueName = (sourceQueueName: string): string =>
  `aiflow.dlq.${sourceQueueName.replace(/^aiflow\.q\./u, '')}`;

export const connectorQueueBinding = (
  connectorId: string,
  capability: 'deliver' | 'ingest',
): QueueBinding => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(connectorId)) {
    throw new Error('CONNECTOR_ID_INVALID');
  }

  return {
    bindingKeys: [
      capability === 'ingest'
        ? `document.ingest.connector.${connectorId}.requested.v1`
        : `execution.stage.deliver.connector.${connectorId}.requested.v1`,
    ],
    name: `aiflow.q.connector.${connectorId}.${capability}.v1`,
  };
};
