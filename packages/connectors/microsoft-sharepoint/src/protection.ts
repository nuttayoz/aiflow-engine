import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

import type { SharePointClientStateKey } from './client-state';

const CURSOR_CONTEXT = 'aiflow:microsoft-sharepoint:cursor:v1';
const MAX_CURSOR_BYTES = 16 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_BYTES = 4;

export interface SharePointCursorProtector {
  protect(value: string): Uint8Array;
  unprotect(value: Uint8Array): string;
}

const cursorKey = (key: SharePointClientStateKey): Buffer =>
  createHmac('sha256', key.rootKey).update(CURSOR_CONTEXT).digest();

export class AesGcmSharePointCursorProtector implements SharePointCursorProtector {
  private readonly keys: ReadonlyMap<number, SharePointClientStateKey>;

  constructor(
    keys: readonly SharePointClientStateKey[],
    private readonly currentKeyVersion: number,
  ) {
    this.keys = new Map(keys.map((key) => [key.keyVersion, key]));
    if (
      this.keys.size !== keys.length ||
      !this.keys.has(currentKeyVersion) ||
      keys.some(
        (key) =>
          !Number.isSafeInteger(key.keyVersion) ||
          key.keyVersion < 1 ||
          key.rootKey.byteLength < 32,
      )
    ) {
      throw new Error('SHAREPOINT_CURSOR_KEYRING_INVALID');
    }
  }

  protect(value: string): Uint8Array {
    const plaintext = Buffer.from(value);
    if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_CURSOR_BYTES) {
      throw new Error('SHAREPOINT_CURSOR_INVALID');
    }
    const key = this.keys.get(this.currentKeyVersion);
    if (key === undefined) throw new Error('SHAREPOINT_CURSOR_KEY_NOT_FOUND');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', cursorKey(key), nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const version = Buffer.alloc(VERSION_BYTES);
    version.writeUInt32BE(this.currentKeyVersion);
    return Buffer.concat([version, nonce, encrypted, cipher.getAuthTag()]);
  }

  unprotect(value: Uint8Array): string {
    const protectedValue = Buffer.from(value);
    if (
      protectedValue.byteLength <= VERSION_BYTES + NONCE_BYTES + TAG_BYTES ||
      protectedValue.byteLength >
        VERSION_BYTES + NONCE_BYTES + TAG_BYTES + MAX_CURSOR_BYTES
    ) {
      throw new Error('SHAREPOINT_CURSOR_CIPHERTEXT_INVALID');
    }
    const keyVersion = protectedValue.readUInt32BE(0);
    const key = this.keys.get(keyVersion);
    if (key === undefined) throw new Error('SHAREPOINT_CURSOR_KEY_NOT_FOUND');
    const nonce = protectedValue.subarray(
      VERSION_BYTES,
      VERSION_BYTES + NONCE_BYTES,
    );
    const tag = protectedValue.subarray(-TAG_BYTES);
    const encrypted = protectedValue.subarray(
      VERSION_BYTES + NONCE_BYTES,
      -TAG_BYTES,
    );
    try {
      const decipher = createDecipheriv('aes-256-gcm', cursorKey(key), nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString();
    } catch {
      throw new Error('SHAREPOINT_CURSOR_CIPHERTEXT_INVALID');
    }
  }
}
