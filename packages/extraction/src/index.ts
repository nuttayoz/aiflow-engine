export interface ExtractionProfileDescriptor {
  readonly outputFields: readonly string[];
  readonly outputSchemaHash: string;
  readonly profileId: string;
  readonly profileKind: 'CUSTOM' | 'SYSTEM';
  readonly profileVersionId: string;
}

export interface ExtractionProfileCatalog {
  find(profileId: string): ExtractionProfileDescriptor | undefined;
}

export class InMemoryExtractionProfileCatalog implements ExtractionProfileCatalog {
  private readonly profiles: ReadonlyMap<string, ExtractionProfileDescriptor>;

  constructor(profiles: readonly ExtractionProfileDescriptor[]) {
    this.profiles = new Map(
      profiles.map((profile) => [profile.profileId, profile]),
    );
    if (this.profiles.size !== profiles.length) {
      throw new Error('EXTRACTION_PROFILE_DUPLICATE');
    }
  }

  find(profileId: string): ExtractionProfileDescriptor | undefined {
    return this.profiles.get(profileId);
  }
}
