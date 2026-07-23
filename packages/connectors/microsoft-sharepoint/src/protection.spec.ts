import {
  AesGcmSharePointCursorProtector,
  type SharePointClientStateKey,
} from './index';

const key = (keyVersion: number, fill: number): SharePointClientStateKey => ({
  keyVersion,
  rootKey: new Uint8Array(32).fill(fill),
});

describe('SharePoint cursor protection', () => {
  it('encrypts opaque cursors and supports key overlap during rotation', () => {
    const keys = [key(1, 1), key(2, 2)];
    const oldProtector = new AesGcmSharePointCursorProtector(keys, 1);
    const newProtector = new AesGcmSharePointCursorProtector(keys, 2);
    const oldCiphertext = oldProtector.protect('opaque-old-delta-cursor');
    const newCiphertext = newProtector.protect('opaque-new-delta-cursor');

    expect(Buffer.from(oldCiphertext).toString()).not.toContain('opaque-old');
    expect(newProtector.unprotect(oldCiphertext)).toBe(
      'opaque-old-delta-cursor',
    );
    expect(newProtector.unprotect(newCiphertext)).toBe(
      'opaque-new-delta-cursor',
    );
  });

  it('rejects tampering and missing historical keys', () => {
    const protector = new AesGcmSharePointCursorProtector([key(1, 1)], 1);
    const ciphertext = protector.protect('opaque-delta-cursor');
    ciphertext[ciphertext.length - 1] ^= 1;

    expect(() => protector.unprotect(ciphertext)).toThrow(
      'SHAREPOINT_CURSOR_CIPHERTEXT_INVALID',
    );
    expect(() =>
      new AesGcmSharePointCursorProtector([key(2, 2)], 2).unprotect(
        protector.protect('old-cursor'),
      ),
    ).toThrow('SHAREPOINT_CURSOR_KEY_NOT_FOUND');
  });
});
