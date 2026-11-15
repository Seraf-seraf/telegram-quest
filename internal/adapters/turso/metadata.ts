import type { ContentMetadata, MetadataStore } from "../../app/metadata.js";
import type { TursoDatabase } from "./client.js";

export function createTursoMetadataStore(database: TursoDatabase): MetadataStore {
  return {
    async getMany(questId, names): Promise<ContentMetadata[]> {
      const uniqueNames = [...new Set(names)];
      if (uniqueNames.length === 0) {
        return [];
      }

      const placeholders = uniqueNames.map(() => "?").join(", ");
      const namespacePredicate = questId === null
        ? "quest_id IS NULL"
        : "quest_id = ?";
      const parameters = questId === null
        ? uniqueNames
        : [questId, ...uniqueNames];

      return database.read(async (executor) => {
        const rows = await executor.all(
          `SELECT name, kind, value
             FROM content_metadata
            WHERE ${namespacePredicate} AND name IN (${placeholders})`,
          ...parameters,
        );

        return rows.map((row) => {
          if (typeof row.name !== "string" || typeof row.kind !== "string" ||
            typeof row.value !== "string") {
            throw new Error("Turso returned invalid content metadata.");
          }
          return { name: row.name, kind: row.kind, value: row.value };
        });
      });
    },
  };
}
