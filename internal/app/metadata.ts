export interface ContentMetadata {
  name: string;
  kind: string;
  value: string;
}

export interface MetadataStore {
  getMany(questId: string | null, names: readonly string[]): Promise<ContentMetadata[]>;
}
