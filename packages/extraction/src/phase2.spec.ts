import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  FakeExtractionProvider,
  PHASE2_INVOICE_PROFILE,
  validateCanonicalExtractionResult,
  verifyExtractionCallback,
} from './index';

const source = Buffer.from('synthetic invoice document');
const submission = () => ({
  expectedContentSha256: createHash('sha256').update(source).digest('hex'),
  expectedSizeBytes: source.length,
  profileId: PHASE2_INVOICE_PROFILE.profileId,
  profileVersionId: PHASE2_INVOICE_PROFILE.profileVersionId,
  source: Readable.from(source),
  submissionKey: 'request-1',
});

describe('fake extraction provider contract', () => {
  it('reuses one stable submission after an uncertain response', async () => {
    const provider = new FakeExtractionProvider('TIMEOUT_AFTER_ACCEPT');
    await expect(provider.submit(submission())).rejects.toThrow(
      'EXTRACTION_OUTCOME_UNKNOWN',
    );
    await expect(
      provider.inspect({ submissionKey: 'request-1' }),
    ).resolves.toEqual({ status: 'SUCCEEDED' });
    await expect(provider.submit(submission())).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(provider.operationCount()).toBe(1);
  });

  it('completes without a callback through inspection', async () => {
    const provider = new FakeExtractionProvider('ACCEPT');
    await provider.submit(submission());
    await expect(
      provider.inspect({ submissionKey: 'request-1' }),
    ).resolves.toMatchObject({ status: 'PENDING' });
    provider.advance('request-1');
    await expect(
      provider.inspect({ submissionKey: 'request-1' }),
    ).resolves.toEqual({ status: 'SUCCEEDED' });
  });

  it('validates the frozen profile and source contract', async () => {
    const provider = new FakeExtractionProvider();
    await provider.submit(submission());
    const result = await provider.fetchResult({ submissionKey: 'request-1' });
    expect(
      validateCanonicalExtractionResult(result, {
        contentSha256: submission().expectedContentSha256,
        outputFields: PHASE2_INVOICE_PROFILE.outputFields,
        profileId: PHASE2_INVOICE_PROFILE.profileId,
        profileVersionId: PHASE2_INVOICE_PROFILE.profileVersionId,
        sizeBytes: source.length,
      }),
    ).toMatchObject({ schemaVersion: 1 });
    expect(() =>
      validateCanonicalExtractionResult(result, {
        contentSha256: '0'.repeat(64),
        outputFields: PHASE2_INVOICE_PROFILE.outputFields,
        profileId: PHASE2_INVOICE_PROFILE.profileId,
        profileVersionId: PHASE2_INVOICE_PROFILE.profileVersionId,
        sizeBytes: source.length,
      }),
    ).toThrow('EXTRACTION_RESULT_INVALID');
  });

  it('models throttling and provider outage without accepting work', async () => {
    await expect(
      new FakeExtractionProvider('THROTTLE').submit(submission()),
    ).rejects.toThrow('EXTRACTION_THROTTLED');
    const unavailable = new FakeExtractionProvider('UNAVAILABLE');
    await expect(unavailable.submit(submission())).rejects.toThrow(
      'EXTRACTION_UNAVAILABLE',
    );
    expect(unavailable.operationCount()).toBe(0);
  });
});

describe('extraction callback authentication', () => {
  it('authenticates the exact raw body and rejects forged or expired requests', () => {
    const now = new Date('2026-07-21T08:00:00.000Z');
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const secret = 'callback-secret';
    const body = Buffer.from(
      JSON.stringify({
        callbackCorrelationId: 'callback-1',
        eventId: 'event-1',
        status: 'COMPLETED',
      }),
    );
    const signature = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest('hex')}`;

    expect(
      verifyExtractionCallback({
        body,
        now,
        secret,
        signature,
        timestamp,
      }),
    ).toMatchObject({ eventId: 'event-1' });
    expect(() =>
      verifyExtractionCallback({
        body,
        now,
        secret,
        signature: `sha256=${'0'.repeat(64)}`,
        timestamp,
      }),
    ).toThrow('EXTRACTION_CALLBACK_UNAUTHENTICATED');
    expect(() =>
      verifyExtractionCallback({
        body,
        now: new Date(now.getTime() + 6 * 60 * 1_000),
        secret,
        signature,
        timestamp,
      }),
    ).toThrow('EXTRACTION_CALLBACK_EXPIRED');
  });
});
