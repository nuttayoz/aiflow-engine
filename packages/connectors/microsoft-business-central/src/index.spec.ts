import { FakeBusinessCentralDestination } from './index';

const input = {
  companyResourceId: 'company-1',
  effectKey: 'effect-1',
  payload: {
    currencyCode: 'THB',
    invoiceDate: '2026-07-21',
    totalAmount: '1250.50',
    vendorInvoiceNumber: 'INV-1',
    vendorNumber: 'V-10000',
  },
  payloadSha256: 'a'.repeat(64),
};

describe('fake Business Central destination', () => {
  it('applies the same effect and hash once', async () => {
    const destination = new FakeBusinessCentralDestination();
    const first = await destination.apply(input);
    await expect(destination.apply(input)).resolves.toEqual(first);
    expect(destination.effectCount()).toBe(1);
  });

  it('reconciles a timeout after applying without another draft', async () => {
    const destination = new FakeBusinessCentralDestination(
      'TIMEOUT_AFTER_APPLY',
    );
    await expect(destination.apply(input)).rejects.toThrow(
      'DESTINATION_WRITE_OUTCOME_UNKNOWN',
    );
    await expect(destination.lookup(input)).resolves.toMatchObject({
      status: 'APPLIED',
    });
    expect(destination.effectCount()).toBe(1);
  });

  it('rejects reuse with a changed hash or company', async () => {
    const destination = new FakeBusinessCentralDestination();
    await destination.apply(input);
    await expect(
      destination.apply({ ...input, payloadSha256: 'b'.repeat(64) }),
    ).rejects.toThrow('DESTINATION_EFFECT_CONFLICT');
  });
});
