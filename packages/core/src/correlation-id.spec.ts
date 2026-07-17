import { resolveCorrelationId } from './correlation-id';

describe('resolveCorrelationId', () => {
  const generatedId = 'generated-correlation-id';
  const generate = (): string => generatedId;

  it('preserves one bounded safe gateway identifier', () => {
    expect(resolveCorrelationId('gateway.request-123:retry_2', generate)).toBe(
      'gateway.request-123:retry_2',
    );
  });

  it.each([
    undefined,
    '',
    ' contains-space',
    'contains?query',
    'x'.repeat(129),
    ['first', 'second'],
  ])('generates an identifier for an unsafe header: %p', (header) => {
    expect(resolveCorrelationId(header, generate)).toBe(generatedId);
  });
});
