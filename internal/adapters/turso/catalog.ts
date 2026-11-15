import { createHash } from "node:crypto";
import type { Quest } from "../../domain/model.js";
import type { GenreEntry, QuestCatalog } from "../../app/quest-catalog.js";
import { assertPageNumber, createPage, pageOffset, PAGE_SIZE } from "../../app/pagination.js";
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

function readCount(row: SqlRow | undefined): number {
  const count = Number(row?.total_items);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Quest catalog count is invalid.");
  }
  return count;
}

function genreKey(name: string): string {
  return createHash("sha256").update(name.normalize("NFC").trim(), "utf8")
    .digest().subarray(0, 8).toString("base64url");
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

    async listQuestsPage(page: number, genre?: string) {
      assertPageNumber(page);
      return database.read(async (executor) => {
        const whereGenre = genre === undefined ? "" : " AND genre = ?";
        const args = genre === undefined ? [] : [genre];
        const count = await executor.get(
          `SELECT COUNT(*) AS total_items FROM quest WHERE available = 1${whereGenre}`,
          ...args,
        );
        const totalItems = readCount(count);
        const totalPages = Math.ceil(totalItems / PAGE_SIZE);
        const actualPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
        const rows = await executor.all(
          `SELECT id, title, description, genre, available
             FROM quest
            WHERE available = 1${whereGenre}
            ORDER BY title COLLATE NOCASE, id
            LIMIT ? OFFSET ?`,
          ...args,
          PAGE_SIZE,
          pageOffset(actualPage, PAGE_SIZE),
        );
        return createPage(rows.map(mapQuest), totalItems, actualPage, PAGE_SIZE);
      });
    },

    async listGenresPage(page: number) {
      assertPageNumber(page);
      return database.read(async (executor) => {
        const count = await executor.get(
          "SELECT COUNT(DISTINCT genre) AS total_items FROM quest WHERE available = 1",
        );
        const totalItems = readCount(count);
        const totalPages = Math.ceil(totalItems / PAGE_SIZE);
        const actualPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
        const rows = await executor.all(
          `SELECT DISTINCT genre FROM quest WHERE available = 1
            ORDER BY genre COLLATE NOCASE, genre LIMIT ? OFFSET ?`,
          PAGE_SIZE,
          pageOffset(actualPage, PAGE_SIZE),
        );
        const items = rows.map((row): GenreEntry => {
          if (typeof row.genre !== "string") throw new Error("Quest genre is invalid.");
          return { name: row.genre, key: genreKey(row.genre) };
        });
        return createPage(items, totalItems, actualPage, PAGE_SIZE);
      });
    },

    async resolveGenreKey(key: string): Promise<string | null> {
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(key)) return null;
      return database.read(async (executor) => {
        const rows = await executor.all(
          "SELECT DISTINCT genre FROM quest WHERE available = 1 ORDER BY genre COLLATE NOCASE, genre",
        );
        const matches = rows.flatMap((row) => typeof row.genre === "string" && genreKey(row.genre) === key ? [row.genre] : []);
        return matches.length === 1 ? matches[0]! : null;
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
