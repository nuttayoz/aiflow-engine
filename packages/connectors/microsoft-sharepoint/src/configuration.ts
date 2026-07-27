export interface SharePointEntryConfiguration extends Readonly<
  Record<string, unknown>
> {
  readonly driveId: string;
  readonly folderId: string;
  readonly includeSubfolders: boolean;
  readonly siteId: string;
}

export interface SharePointConnectionConfiguration extends Readonly<
  Record<string, unknown>
> {
  readonly externalTenantId: string;
  readonly identityMode: 'SAAS_MULTITENANT';
  readonly permissionProfile: 'FILES_AND_SITES_READ_ALL_V1';
}

const entraTenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const isSharePointConnectionConfiguration = (
  value: unknown,
): value is SharePointConnectionConfiguration => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const configuration = value as Record<string, unknown>;
  return (
    Object.keys(configuration).length === 3 &&
    typeof configuration.externalTenantId === 'string' &&
    entraTenantIdPattern.test(configuration.externalTenantId) &&
    configuration.identityMode === 'SAAS_MULTITENANT' &&
    configuration.permissionProfile === 'FILES_AND_SITES_READ_ALL_V1'
  );
};

const configurationKeys = [
  'driveId',
  'folderId',
  'includeSubfolders',
  'siteId',
] as const;

const isOpaqueResourceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

export const isSharePointEntryConfiguration = (
  value: unknown,
): value is SharePointEntryConfiguration => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const configuration = value as Record<string, unknown>;
  return (
    Object.keys(configuration).every((key) =>
      configurationKeys.includes(key as never),
    ) &&
    configurationKeys.every((key) => key in configuration) &&
    isOpaqueResourceId(configuration.siteId) &&
    isOpaqueResourceId(configuration.driveId) &&
    isOpaqueResourceId(configuration.folderId) &&
    typeof configuration.includeSubfolders === 'boolean'
  );
};
