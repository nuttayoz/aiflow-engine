import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const CLIENT_STATE_CONTEXT = 'aiflow:microsoft-sharepoint:client-state:v1';
const MAX_WATCH_ID_LENGTH = 128;
const MIN_ROOT_KEY_BYTES = 32;

export interface SharePointClientStateKey {
  readonly keyVersion: number;
  readonly rootKey: Uint8Array;
}

const validateKey = ({
  keyVersion,
  rootKey,
}: SharePointClientStateKey): void => {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error('SHAREPOINT_CLIENT_STATE_KEY_VERSION_INVALID');
  }
  if (rootKey.byteLength < MIN_ROOT_KEY_BYTES) {
    throw new Error('SHAREPOINT_CLIENT_STATE_ROOT_KEY_INVALID');
  }
};

const validateWatchId = (watchId: string): void => {
  if (watchId.length === 0 || watchId.length > MAX_WATCH_ID_LENGTH) {
    throw new Error('SHAREPOINT_CLIENT_STATE_WATCH_ID_INVALID');
  }
};

export const deriveSharePointClientState = (
  watchId: string,
  key: SharePointClientStateKey,
): string => {
  validateWatchId(watchId);
  validateKey(key);
  const mac = createHmac('sha256', key.rootKey)
    .update(CLIENT_STATE_CONTEXT)
    .update('\0')
    .update(key.keyVersion.toString())
    .update('\0')
    .update(watchId)
    .digest('base64url');
  return `v${key.keyVersion.toString()}.${mac}`;
};

export const sharePointClientStateDigest = (clientState: string): string =>
  createHash('sha256').update(clientState).digest('hex');

export const verifySharePointClientStateDigest = (
  suppliedClientState: string,
  expectedDigest: string,
): boolean => {
  const suppliedDigest = Buffer.from(
    sharePointClientStateDigest(suppliedClientState),
    'hex',
  );
  const expected = Buffer.from(expectedDigest, 'hex');
  return (
    expected.byteLength === suppliedDigest.byteLength &&
    timingSafeEqual(suppliedDigest, expected)
  );
};

export const verifySharePointClientState = (
  suppliedClientState: string,
  watchId: string,
  key: SharePointClientStateKey,
): boolean => {
  const expected = Buffer.from(deriveSharePointClientState(watchId, key));
  const supplied = Buffer.from(suppliedClientState);
  return (
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
};
