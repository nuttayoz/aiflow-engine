import {
  deriveSharePointClientState,
  sharePointClientStateDigest,
  verifySharePointClientState,
} from './client-state';

const key = {
  keyVersion: 3,
  rootKey: new Uint8Array(32).fill(7),
};

describe('SharePoint client state', () => {
  it('derives a bounded deterministic value without exposing the root key', () => {
    const first = deriveSharePointClientState('watch-1', key);

    expect(first).toBe(deriveSharePointClientState('watch-1', key));
    expect(first).toMatch(/^v3\.[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(Buffer.from(key.rootKey).toString('base64url'));
    expect(sharePointClientStateDigest(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds verification to the watch and key version', () => {
    const state = deriveSharePointClientState('watch-1', key);

    expect(verifySharePointClientState(state, 'watch-1', key)).toBe(true);
    expect(verifySharePointClientState(`${state}x`, 'watch-1', key)).toBe(
      false,
    );
    expect(verifySharePointClientState(state, 'watch-2', key)).toBe(false);
    expect(
      verifySharePointClientState(state, 'watch-1', {
        ...key,
        keyVersion: 4,
      }),
    ).toBe(false);
  });

  it('rejects weak root keys and invalid key versions', () => {
    expect(() =>
      deriveSharePointClientState('watch-1', {
        keyVersion: 0,
        rootKey: key.rootKey,
      }),
    ).toThrow('SHAREPOINT_CLIENT_STATE_KEY_VERSION_INVALID');
    expect(() =>
      deriveSharePointClientState('watch-1', {
        keyVersion: 1,
        rootKey: new Uint8Array(31),
      }),
    ).toThrow('SHAREPOINT_CLIENT_STATE_ROOT_KEY_INVALID');
  });
});
