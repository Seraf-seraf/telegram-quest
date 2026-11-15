import type { Quest, QuestVersion } from "../../domain/model.js";
import type { QuestCatalog } from "../../app/quest-catalog.js";
import type { SqlRow, TursoDatabase } from "./client.js";

function readString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error("Quest catalog data is invalid.");
  }
  return value;
}

function readAvailability(row: SqlRow): boolean {
  const value = row.available;
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  throw new Error("Quest catalog data is invalid.");
}

function mapQuest(row: SqlRow): Quest {
  return {
    id: readString(row, "id"),
    title: readString(row, "title"),
    description: readString(row, "description"),
    genre: readString(row, "genre"),
    available: readAvailability(row),
  };
}

function mapQuestVersion(row: SqlRow): QuestVersion {
  const storyHash = readString(row, "story_hash");
  if (!/^[a-f\d]{64}$/i.test(storyHash)) {
    throw new Error("Quest catalog data is invalid.");
  }

  return {
    id: readString(row, "id"),
    questId: readString(row, "quest_id"),
    version: readString(row, "version"),
    storyReference: readString(row, "story_ref"),
    storyHash,
  };
}

export function createTursoQuestCatalog(database: TursoDatabase): QuestCatalog {
  return {
    async listAvailableQuests(): Promise<Quest[]> {
      return database.read(async (executor) => {
        const rows = await executor.all(
          `SELECT id, title, description, genre, available
             FROM quest
            WHERE available = 1
            ORDER BY title COLLATE NOCASE, id`,
        );
        return rows.map(mapQuest);
      });
    },

    async listVersions(questId: string): Promise<QuestVersion[]> {
      return database.read(async (executor) => {
        const rows = await executor.all(
          `SELECT quest_version.id, quest_version.quest_id, quest_version.version,
                  quest_version.story_ref, quest_version.story_hash
             FROM quest_version
             JOIN quest ON quest.id = quest_version.quest_id
            WHERE quest_version.quest_id = ? AND quest.available = 1
            ORDER BY quest_version.version, quest_version.id`,
          questId,
        );
        return rows.map(mapQuestVersion);
      });
    },

    async getQuestVersion(questVersionId: string): Promise<QuestVersion | null> {
      return database.read(async (executor) => {
        const row = await executor.get(
          `SELECT quest_version.id, quest_version.quest_id, quest_version.version,
                  quest_version.story_ref, quest_version.story_hash
             FROM quest_version
             JOIN quest ON quest.id = quest_version.quest_id
            WHERE quest_version.id = ? AND quest.available = 1`,
          questVersionId,
        );
        return row === undefined ? null : mapQuestVersion(row);
      });
    },
  };
}
