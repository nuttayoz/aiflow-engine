import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';

export interface ExtractionProfileDescriptor {
  readonly outputFields: readonly string[];
  readonly outputSchemaHash: string;
  readonly profileId: string;
  readonly profileKind: 'CUSTOM' | 'SYSTEM';
  readonly profileVersionId: string;
}

export const PHASE2_INVOICE_PROFILE: ExtractionProfileDescriptor =
  Object.freeze({
    outputFields: [
      'currency_code',
      'invoice_date',
      'invoice_number',
      'total',
      'vendor_number',
    ],
    outputSchemaHash: createHash('sha256')
      .update('aiflow.phase2.invoice-profile.v1')
      .digest('hex'),
    profileId: 'invoice-basic',
    profileKind: 'SYSTEM',
    profileVersionId: 'invoice-basic-v1',
  });

export interface ExtractionProfileCatalog {
  find(profileId: string): ExtractionProfileDescriptor | undefined;
}

export class InMemoryExtractionProfileCatalog implements ExtractionProfileCatalog {
  private readonly profiles: ReadonlyMap<string, ExtractionProfileDescriptor>;

  constructor(profiles: readonly ExtractionProfileDescriptor[]) {
    this.profiles = new Map(
      profiles.map((profile) => [profile.profileId, profile]),
    );
    if (this.profiles.size !== profiles.length) {
      throw new Error('EXTRACTION_PROFILE_DUPLICATE');
    }
  }

  find(profileId: string): ExtractionProfileDescriptor | undefined {
    return this.profiles.get(profileId);
  }

  list(): readonly ExtractionProfileDescriptor[] {
    return [...this.profiles.values()];
  }
}

export interface CanonicalExtractionResult {
  readonly confidence: readonly {
    readonly path: string;
    readonly score: number;
  }[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly pageCount: number;
  readonly profile: {
    readonly profileId: string;
    readonly profileVersionId: string;
  };
  readonly schemaVersion: 1;
  readonly source: {
    readonly contentSha256: string;
    readonly sizeBytes: number;
  };
  readonly warnings: readonly string[];
}

export type ExtractionInspection =
  | { readonly status: 'FAILED'; readonly failureCode: string }
  | { readonly status: 'NOT_FOUND' }
  | { readonly retryAfter?: Date; readonly status: 'PENDING' }
  | { readonly status: 'SUCCEEDED' };

export interface ExtractionProviderPort {
  fetchResult(input: {
    readonly providerOperationRef?: string;
    readonly submissionKey: string;
  }): Promise<unknown>;
  inspect(input: {
    readonly providerOperationRef?: string;
    readonly submissionKey: string;
  }): Promise<ExtractionInspection>;
  submit(input: {
    readonly expectedContentSha256: string;
    readonly expectedSizeBytes: number;
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly source: Readable;
    readonly submissionKey: string;
  }): Promise<{
    readonly providerOperationRef: string;
    readonly status: 'ACCEPTED' | 'COMPLETED';
  }>;
}

export class ExtractionProviderError extends Error {
  constructor(
    readonly code:
      | 'EXTRACTION_OUTCOME_UNKNOWN'
      | 'EXTRACTION_THROTTLED'
      | 'EXTRACTION_UNAVAILABLE',
    readonly retryAfter?: Date,
  ) {
    super(code);
    this.name = 'ExtractionProviderError';
  }
}

export type FakeExtractionBehavior =
  | 'ACCEPT'
  | 'COMPLETE'
  | 'MALFORMED_RESULT'
  | 'THROTTLE'
  | 'TIMEOUT_AFTER_ACCEPT'
  | 'UNAVAILABLE';

interface FakeOperation {
  readonly providerOperationRef: string;
  readonly result: unknown;
  status: 'PENDING' | 'SUCCEEDED';
}

const drainSource = async (
  source: Readable,
): Promise<{ readonly digest: string; readonly sizeBytes: number }> => {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { digest: hash.digest('hex'), sizeBytes };
};

export class FakeExtractionProvider implements ExtractionProviderPort {
  private readonly operations = new Map<string, FakeOperation>();

  constructor(
    private behavior: FakeExtractionBehavior = 'COMPLETE',
    private readonly clock: () => Date = () => new Date(),
  ) {}

  setBehavior(behavior: FakeExtractionBehavior): void {
    this.behavior = behavior;
  }

  advance(submissionKey: string): void {
    const operation = this.operations.get(submissionKey);
    if (operation !== undefined) {
      operation.status = 'SUCCEEDED';
    }
  }

  async submit(input: {
    readonly expectedContentSha256: string;
    readonly expectedSizeBytes: number;
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly source: Readable;
    readonly submissionKey: string;
  }): Promise<{
    readonly providerOperationRef: string;
    readonly status: 'ACCEPTED' | 'COMPLETED';
  }> {
    const existing = this.operations.get(input.submissionKey);
    if (existing !== undefined) {
      input.source.destroy();
      return {
        providerOperationRef: existing.providerOperationRef,
        status: existing.status === 'SUCCEEDED' ? 'COMPLETED' : 'ACCEPTED',
      };
    }
    if (this.behavior === 'THROTTLE') {
      input.source.destroy();
      throw new ExtractionProviderError(
        'EXTRACTION_THROTTLED',
        new Date(this.clock().getTime() + 1_000),
      );
    }
    if (this.behavior === 'UNAVAILABLE') {
      input.source.destroy();
      throw new ExtractionProviderError('EXTRACTION_UNAVAILABLE');
    }
    const source = await drainSource(input.source);
    if (
      source.digest !== input.expectedContentSha256 ||
      source.sizeBytes !== input.expectedSizeBytes
    ) {
      throw new Error('EXTRACTION_SOURCE_INTEGRITY_MISMATCH');
    }
    const providerOperationRef = `fake-ocr-${input.submissionKey}`;
    const result: CanonicalExtractionResult | { malformed: true } =
      this.behavior === 'MALFORMED_RESULT'
        ? { malformed: true }
        : {
            confidence: [
              { path: '/invoice_number', score: 0.99 },
              { path: '/total', score: 0.95 },
            ],
            data: {
              currency_code: 'THB',
              invoice_date: '2026-07-21',
              invoice_number: 'INV-DEMO-001',
              total: '1250.50',
              vendor_number: 'V-10000',
            },
            pageCount: 1,
            profile: {
              profileId: input.profileId,
              profileVersionId: input.profileVersionId,
            },
            schemaVersion: 1,
            source: {
              contentSha256: source.digest,
              sizeBytes: source.sizeBytes,
            },
            warnings: [],
          };
    const operation: FakeOperation = {
      providerOperationRef,
      result,
      status: this.behavior === 'ACCEPT' ? 'PENDING' : 'SUCCEEDED',
    };
    this.operations.set(input.submissionKey, operation);
    if (this.behavior === 'TIMEOUT_AFTER_ACCEPT') {
      throw new ExtractionProviderError('EXTRACTION_OUTCOME_UNKNOWN');
    }
    return {
      providerOperationRef,
      status: operation.status === 'SUCCEEDED' ? 'COMPLETED' : 'ACCEPTED',
    };
  }

  async inspect(input: {
    readonly providerOperationRef?: string;
    readonly submissionKey: string;
  }): Promise<ExtractionInspection> {
    const operation = this.operations.get(input.submissionKey);
    if (operation === undefined) {
      return { status: 'NOT_FOUND' };
    }
    if (
      input.providerOperationRef !== undefined &&
      input.providerOperationRef !== operation.providerOperationRef
    ) {
      return { status: 'NOT_FOUND' };
    }
    return operation.status === 'SUCCEEDED'
      ? { status: 'SUCCEEDED' }
      : {
          retryAfter: new Date(this.clock().getTime() + 1_000),
          status: 'PENDING',
        };
  }

  async fetchResult(input: {
    readonly providerOperationRef?: string;
    readonly submissionKey: string;
  }): Promise<unknown> {
    const operation = this.operations.get(input.submissionKey);
    if (
      operation === undefined ||
      operation.status !== 'SUCCEEDED' ||
      (input.providerOperationRef !== undefined &&
        input.providerOperationRef !== operation.providerOperationRef)
    ) {
      throw new Error('EXTRACTION_RESULT_NOT_AVAILABLE');
    }
    return operation.result;
  }

  operationCount(): number {
    return this.operations.size;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const validateCanonicalExtractionResult = (
  value: unknown,
  expected: {
    readonly contentSha256: string;
    readonly outputFields: readonly string[];
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly sizeBytes: number;
  },
): CanonicalExtractionResult => {
  if (!isRecord(value)) {
    throw new Error('EXTRACTION_RESULT_INVALID');
  }
  const profile = value.profile;
  const source = value.source;
  const data = value.data;
  const confidence = value.confidence;
  const warnings = value.warnings;
  if (
    value.schemaVersion !== 1 ||
    !isRecord(profile) ||
    profile.profileId !== expected.profileId ||
    profile.profileVersionId !== expected.profileVersionId ||
    !isRecord(source) ||
    source.contentSha256 !== expected.contentSha256 ||
    source.sizeBytes !== expected.sizeBytes ||
    !Number.isInteger(value.pageCount) ||
    Number(value.pageCount) < 1 ||
    Number(value.pageCount) > 500 ||
    !isRecord(data) ||
    !Object.keys(data).every((key) => expected.outputFields.includes(key)) ||
    !Array.isArray(confidence) ||
    !confidence.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        typeof entry.score === 'number' &&
        Number.isFinite(entry.score) &&
        entry.score >= 0 &&
        entry.score <= 1,
    ) ||
    !Array.isArray(warnings) ||
    !warnings.every((warning) => typeof warning === 'string')
  ) {
    throw new Error('EXTRACTION_RESULT_INVALID');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) {
    throw new Error('EXTRACTION_RESULT_TOO_LARGE');
  }
  return value as unknown as CanonicalExtractionResult;
};

export const encodeCanonicalExtractionResult = (
  result: CanonicalExtractionResult,
): Buffer => Buffer.from(JSON.stringify(result));

export interface AuthenticatedExtractionCallback {
  readonly callbackCorrelationId: string;
  readonly eventId: string;
  readonly status: 'COMPLETED' | 'FAILED';
}

export const verifyExtractionCallback = (input: {
  readonly body: Buffer;
  readonly now: Date;
  readonly secret: string;
  readonly signature: string;
  readonly timestamp: string;
}): AuthenticatedExtractionCallback => {
  const timestampSeconds = Number(input.timestamp);
  if (
    !Number.isInteger(timestampSeconds) ||
    Math.abs(input.now.getTime() - timestampSeconds * 1_000) > 5 * 60 * 1_000
  ) {
    throw new Error('EXTRACTION_CALLBACK_EXPIRED');
  }
  const expected = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.`)
    .update(input.body)
    .digest();
  const suppliedHex = input.signature.replace(/^sha256=/u, '');
  const supplied = /^[a-f0-9]{64}$/u.test(suppliedHex)
    ? Buffer.from(suppliedHex, 'hex')
    : Buffer.alloc(0);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error('EXTRACTION_CALLBACK_UNAUTHENTICATED');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.body.toString('utf8')) as unknown;
  } catch {
    throw new Error('EXTRACTION_CALLBACK_INVALID');
  }
  if (
    !isRecord(decoded) ||
    typeof decoded.eventId !== 'string' ||
    decoded.eventId.length === 0 ||
    decoded.eventId.length > 180 ||
    typeof decoded.callbackCorrelationId !== 'string' ||
    decoded.callbackCorrelationId.length === 0 ||
    decoded.callbackCorrelationId.length > 180 ||
    !['COMPLETED', 'FAILED'].includes(String(decoded.status))
  ) {
    throw new Error('EXTRACTION_CALLBACK_INVALID');
  }
  return decoded as unknown as AuthenticatedExtractionCallback;
};

export * from './processor';
