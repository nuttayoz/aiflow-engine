import { applyMappings, encodeCanonicalMapping, MappingError } from './index';

describe('workflow mapping', () => {
  it('maps stable source paths into one canonical payload', () => {
    const result = applyMappings(
      { invoice: { number: 'INV-1' }, total: '1250.50' },
      [
        {
          required: true,
          sourceField: 'invoice.number',
          targetField: 'vendorInvoiceNumber',
        },
        { sourceField: '/total', targetField: 'totalAmount' },
      ],
    );

    expect(result.payload).toEqual({
      totalAmount: '1250.50',
      vendorInvoiceNumber: 'INV-1',
    });
    expect(result.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(encodeCanonicalMapping(result).toString())).toEqual({
      data: result.payload,
      payloadSha256: result.payloadSha256,
      schemaVersion: 1,
    });
  });

  it('rejects missing required values and duplicate targets', () => {
    expect(() =>
      applyMappings({}, [
        { required: true, sourceField: 'missing', targetField: 'target' },
      ]),
    ).toThrow(new MappingError('MAPPING_REQUIRED_VALUE_MISSING'));
    expect(() =>
      applyMappings({ a: 1, b: 2 }, [
        { sourceField: 'a', targetField: 'same' },
        { sourceField: 'b', targetField: 'same' },
      ]),
    ).toThrow(new MappingError('MAPPING_INVALID'));
  });
});
