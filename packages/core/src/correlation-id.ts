import { randomUUID } from 'node:crypto';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CorrelationIdHeader = string | string[] | undefined;

export const resolveCorrelationId = (
  header: CorrelationIdHeader,
  generate: () => string = randomUUID,
): string => {
  if (typeof header === 'string' && CORRELATION_ID_PATTERN.test(header)) {
    return header;
  }

  return generate();
};
