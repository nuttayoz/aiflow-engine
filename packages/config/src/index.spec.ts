import { loadApiRuntimeConfig } from './index';

describe('loadApiRuntimeConfig', () => {
  it('uses safe defaults', () => {
    expect(loadApiRuntimeConfig({})).toEqual({
      host: '0.0.0.0',
      port: 3000,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadApiRuntimeConfig({ API_PORT: '70000' })).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );
  });
});
