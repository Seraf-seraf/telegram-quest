import type { Quest } from "../../domain/model.js";
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

    async getQuest(questId: string): Promise<Quest | null> {
      return database.read(async (executor) => {
        const row = await executor.get(
          `SELECT id, title, description, genre, available
             FROM quest
            WHERE id = ?`,
          questId,
        );
        return row === undefined ? null : mapQuest(row);
      });
    },
  };
}
