import {
  connectorQueueBinding,
  queueNameForSelection,
} from '@aiflow/messaging';

const DEFAULT_FOUNDATION_SELECTIONS = [
  'provisioning',
  'extract',
  'map',
  'reconcile',
  'microsoft-business-central',
  'phase1-synthetic',
] as const;

export const parseQueueSelection = (arguments_: string[]): string[] => {
  const queuesArgument = arguments_.find((argument) =>
    argument.startsWith('--queues='),
  );

  if (queuesArgument === undefined) {
    return [];
  }

  return [
    ...new Set(
      queuesArgument
        .slice('--queues='.length)
        .split(',')
        .map((queue) => queue.trim())
        .filter((queue) => queue.length > 0),
    ),
  ];
};

export const resolveQueueNames = (selections: readonly string[]): string[] => {
  const selected =
    selections.length === 0 ? DEFAULT_FOUNDATION_SELECTIONS : selections;

  return selected.map((selection) => {
    if (selection === 'phase1-synthetic') {
      return connectorQueueBinding('phase1-synthetic', 'deliver').name;
    }
    if (selection === 'microsoft-business-central') {
      return connectorQueueBinding('microsoft-business-central', 'deliver')
        .name;
    }
    const queueName = queueNameForSelection(selection);
    if (queueName === undefined) {
      throw new Error(`WORKER_QUEUE_SELECTION_INVALID:${selection}`);
    }
    return queueName;
  });
};
