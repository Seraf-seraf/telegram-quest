import { StorySourceError, type StorySource } from "../../app/story-source.js";
import type { SqlRow, TursoDatabase } from "./client.js";

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createTursoStorySource(database: TursoDatabase): StorySource {
  return {
    async load(questId: string): Promise<string> {
      let row: SqlRow | undefined;
      try {
        row = await database.read((executor) => executor.get(
          "SELECT story_json FROM quest WHERE id = ?",
          questId,
        ));
      } catch (error) {
        throw new StorySourceError("STORAGE_FAILURE", "Quest story could not be loaded.", {
          cause: error,
        });
      }

      if (row === undefined) {
        throw new StorySourceError("NOT_FOUND", "Quest story was not found.");
      }

      const storyJson = row.story_json;
      if (typeof storyJson !== "string") {
        throw new StorySourceError("STORAGE_FAILURE", "Quest story data is invalid.");
      }

      try {
        if (!isJsonObject(JSON.parse(storyJson))) {
          throw new Error("Stored Ink story is not a JSON object.");
        }
      } catch (error) {
        throw new StorySourceError("STORAGE_FAILURE", "Quest story data is invalid.", {
          cause: error,
        });
      }

      return storyJson;
    },
  };
}
