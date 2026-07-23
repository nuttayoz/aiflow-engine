export interface SharePointEntryConfiguration extends Readonly<
  Record<string, unknown>
> {
  readonly driveId: string;
  readonly folderId: string;
  readonly includeSubfolders: boolean;
  readonly siteId: string;
}

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
