import { createHash } from 'node:crypto';

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4_PATTERN = new RegExp(`^${UUID_V4_SOURCE}$`, 'u');
const STORAGE_OBJECT_KEY_PATTERN = new RegExp(
  `^v1/t/[0-9a-f]{64}/o/${UUID_V4_SOURCE}$`,
  'u',
);

export const isStorageObjectKey = (key: string): boolean =>
  STORAGE_OBJECT_KEY_PATTERN.test(key);

export const tenantScopeHash = (tenantId: string): string => {
  const normalized = tenantId.trim();

  if (normalized.length === 0 || normalized.length > 180) {
    throw new Error('TENANT_ID_INVALID');
  }

  return createHash('sha256').update(normalized).digest('hex');
};

export const buildStorageObjectKey = (
  tenantId: string,
  storageObjectId: string,
): string => {
  if (!UUID_V4_PATTERN.test(storageObjectId)) {
    throw new Error('STORAGE_OBJECT_ID_INVALID');
  }

  return `v1/t/${tenantScopeHash(tenantId)}/o/${storageObjectId}`;
};
