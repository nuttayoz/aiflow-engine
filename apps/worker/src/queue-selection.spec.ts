import { parseQueueSelection } from './queue-selection';

describe('parseQueueSelection', () => {
  it('returns an empty list when no queues are requested', () => {
    expect(parseQueueSelection([])).toEqual([]);
  });

  it('normalizes and deduplicates queue names', () => {
    expect(
      parseQueueSelection(['--queues=extract, map,extract,,deliver.dynamics']),
    ).toEqual(['extract', 'map', 'deliver.dynamics']);
  });
});
