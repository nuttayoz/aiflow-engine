import { createHash } from 'node:crypto';

export interface MappingRule {
  readonly required?: boolean;
  readonly sourceField: string;
  readonly targetField: string;
}

export interface MappingResult {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadSha256: string;
  readonly schemaVersion: 1;
}

export class MappingError extends Error {
  constructor(
    readonly code: 'MAPPING_INVALID' | 'MAPPING_REQUIRED_VALUE_MISSING',
  ) {
    super(code);
    this.name = 'MappingError';
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const sourceValue = (
  data: Readonly<Record<string, unknown>>,
  path: string,
): unknown => {
  const segments = path.startsWith('/')
    ? path
        .slice(1)
        .split('/')
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    : path.split('.');
  let current: unknown = data;
  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
};

const validPath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 256 &&
  [...value].every((character) => character.charCodeAt(0) > 31);

export const applyMappings = (
  data: Readonly<Record<string, unknown>>,
  rules: readonly MappingRule[],
): MappingResult => {
  if (rules.length === 0 || rules.length > 1_000) {
    throw new MappingError('MAPPING_INVALID');
  }
  const payload: Record<string, unknown> = {};
  for (const rule of rules) {
    if (
      !validPath(rule.sourceField) ||
      !validPath(rule.targetField) ||
      Object.hasOwn(payload, rule.targetField)
    ) {
      throw new MappingError('MAPPING_INVALID');
    }
    const value = sourceValue(data, rule.sourceField);
    if (value === undefined || value === null) {
      if (rule.required) {
        throw new MappingError('MAPPING_REQUIRED_VALUE_MISSING');
      }
      continue;
    }
    payload[rule.targetField] = value;
  }
  const encoded = stableJson(payload);
  if (Buffer.byteLength(encoded) > 1024 * 1024) {
    throw new MappingError('MAPPING_INVALID');
  }
  return {
    payload: Object.freeze(payload),
    payloadSha256: createHash('sha256').update(encoded).digest('hex'),
    schemaVersion: 1,
  };
};

export const encodeCanonicalMapping = (result: MappingResult): Buffer =>
  Buffer.from(
    stableJson({
      data: result.payload,
      payloadSha256: result.payloadSha256,
      schemaVersion: result.schemaVersion,
    }),
  );

export * from './processor';
