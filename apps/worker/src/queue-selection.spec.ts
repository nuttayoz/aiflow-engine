import { parseQueueSelection, resolveQueueNames } from './queue-selection';

describe('parseQueueSelection', () => {
  it('returns an empty list when no queues are requested', () => {
    expect(parseQueueSelection([])).toEqual([]);
  });

  it('normalizes and deduplicates queue names', () => {
    expect(
      parseQueueSelection(['--queues=extract, map,extract,,deliver.dynamics']),
    ).toEqual(['extract', 'map', 'deliver.dynamics']);
  });

  it('runs all synthetic foundation queues by default', () => {
    expect(resolveQueueNames([])).toEqual([
      'aiflow.q.workflow.provisioning.v1',
      'aiflow.q.stage.extract.v1',
      'aiflow.q.stage.map.v1',
      'aiflow.q.stage.reconcile.v1',
      'aiflow.q.connector.microsoft-business-central.deliver.v1',
      'aiflow.q.connector.microsoft-sharepoint.sync.v1',
      'aiflow.q.connector.phase1-synthetic.deliver.v1',
    ]);
  });

  it('rejects unknown queue selections', () => {
    expect(() => resolveQueueNames(['unknown'])).toThrow(
      'WORKER_QUEUE_SELECTION_INVALID:unknown',
    );
  });
});
