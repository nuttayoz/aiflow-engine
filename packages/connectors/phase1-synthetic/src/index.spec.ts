import { runConnectorContractChecks } from '@aiflow/connector-test-suite';

import { phase1SyntheticConnector } from './index';

describe('Phase 1 synthetic connector', () => {
  it('passes the shared connector contract', () => {
    expect(runConnectorContractChecks(phase1SyntheticConnector)).toEqual([]);
  });
});
