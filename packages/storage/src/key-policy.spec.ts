import { buildStorageObjectKey, tenantScopeHash } from './key-policy';

describe('storage key policy', () => {
  it('creates tenant-isolated keys without exposing tenant or filenames', () => {
    const objectId = '550e8400-e29b-41d4-a716-446655440000';
    const key = buildStorageObjectKey('tenant@example.com', objectId);

    expect(key).toBe(
      `v1/t/${tenantScopeHash('tenant@example.com')}/o/${objectId}`,
    );
    expect(key).not.toContain('tenant@example.com');
    expect(buildStorageObjectKey('another-tenant', objectId)).not.toBe(key);
  });

  it('rejects invalid object and tenant identities', () => {
    expect(() => buildStorageObjectKey('', 'not-a-uuid')).toThrow(
      'STORAGE_OBJECT_ID_INVALID',
    );
    expect(() => tenantScopeHash('')).toThrow('TENANT_ID_INVALID');
  });
});
