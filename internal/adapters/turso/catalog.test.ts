import { createClient, type Transaction } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, TursoDatabase } from "./client.js";
import { createTursoQuestCatalog } from "./catalog.js";
import { ensureSchema } from "./migrate.js";
import { ensureDemoCatalog } from "./seed.js";
import { createTursoStorySource } from "./story-source.js";
import { initializeApp } from "../../bootstrap.js";
import type { SessionOwner } from "../../domain/model.js";
import { StorySourceError } from "../../app/story-source.js";

const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "test-token",
};
const demoQuestId = "telegram-quest-demo";
const userOwner: SessionOwner = { type: "user", id: "42" };
const openDatabases = new Set<TursoDatabase>();

function createMemoryDatabase(): TursoDatabase {
  const client = createClient({ url: "file::memory:", concurrency: 1 });
  let closed = false;

  function executorFor(connection: ReturnType<typeof createClient> | Transaction): SqlExecutor {
    return {
      all: async (sql, ...args): Promise<SqlRow[]> => {
        const result = await connection.execute({ sql, args: [...args] });
        return result.rows as unknown as SqlRow[];
      },
      exec: async (sql): Promise<void> => {
        await connection.executeMultiple(sql);
      },
      get: async (sql, ...args): Promise<SqlRow | undefined> => {
        const result = await connection.execute({ sql, args: [...args] });
        return result.rows[0] as unknown as SqlRow | undefined;
      },
      run: async (sql, ...args): Promise<void> => {
        await connection.execute({ sql, args: [...args] });
      },
    };
  }

  const database: TursoDatabase = {
    close(): void {
      if (!closed) {
        client.close();
        closed = true;
      }
    },
    read<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("Local test database is closed.");
      }
      return operation(executorFor(client));
    },
    async write<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("Local test database is closed.");
      }
      const transaction = await client.transaction("write");
      try {
        const result = await operation(executorFor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        if (!transaction.closed) {
          await transaction.rollback();
        }
        throw error;
      } finally {
        transaction.close();
      }
    },
  };

  openDatabases.add(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases) {
    database.close();
  }
  openDatabases.clear();
});

async function initializeTestSchema(database: TursoDatabase): Promise<void> {
  await ensureSchema(database);
}

async function readSeedRows(database: TursoDatabase): Promise<{
  quest: SqlRow | undefined;
}> {
  return database.read(async (executor) => ({
    quest: await executor.get(
      "SELECT id, title, description, genre, available, story_json FROM quest WHERE id = ?",
      demoQuestId,
    ),
  }));
}

describe("Turso quest catalog and story source", () => {
  it("bootstraps the demo quest and starts it through the real Ink runtime", async () => {
    const database = createMemoryDatabase();
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
    });

    const quests = await app.catalog.listAvailableQuests();
    expect(quests).toEqual([{
      id: demoQuestId,
      title: "Две двери",
      description: "Короткий демонстрационный квест с двумя ветвями и финалами.",
      genre: "Приключения",
      available: true,
    }]);
    expect(await app.catalog.getQuest(demoQuestId)).toEqual(quests[0]);

    const initial = await app.sessions.createSession(userOwner, demoQuestId, 1);
    const started = await app.sessions.startSession(
      userOwner,
      initial.id,
      initial.stateVersion,
    );
    expect(started.status).toBe("active");
    expect(started.turns[0]?.choices.length).toBeGreaterThan(0);

    const before = await readSeedRows(database);
    await ensureDemoCatalog(database);
    expect(await readSeedRows(database)).toEqual(before);
  });

  it("does not list hidden quests but keeps them addressable by ID", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await ensureDemoCatalog(database);
    const demoStory = await database.read(async (executor) => executor.get(
      "SELECT story_json FROM quest WHERE id = ?",
      demoQuestId,
    ));
    if (typeof demoStory?.story_json !== "string") {
      throw new Error("Seeded demo story is missing from the test database.");
    }
    const demoStoryJson = demoStory.story_json;
    await database.write(async (executor) => {
      await executor.run(
        `INSERT INTO quest (id, title, description, genre, available, story_json)
         VALUES (?, ?, ?, ?, 0, ?)`,
        "hidden-quest",
        "Hidden",
        "Not published",
        "adventure",
        demoStoryJson,
      );
    });

    const catalog = createTursoQuestCatalog(database);
    expect((await catalog.listAvailableQuests()).map((quest) => quest.id))
      .toEqual([demoQuestId]);
    expect(await catalog.getQuest("hidden-quest")).toMatchObject({
      id: "hidden-quest",
      available: false,
    });
  });

  it("pages available quests and genres and resolves only current unambiguous genre keys", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await ensureDemoCatalog(database);
    const story = await database.read(async (executor) => executor.get(
      "SELECT story_json FROM quest WHERE id = ?", demoQuestId,
    ));
    if (typeof story?.story_json !== "string") throw new Error("Demo story is missing.");
    const storyJson = story.story_json;
    await database.write(async (executor) => {
      for (let index = 0; index < 11; index += 1) {
        await executor.run(
          `INSERT INTO quest (id, title, description, genre, available, story_json)
           VALUES (?, ?, '', ?, 1, ?)`,
          `quest-${String(index).padStart(2, "0")}`,
          `Quest ${String(index).padStart(2, "0")}`,
          index < 6 ? "Приключения" : `Жанр ${index}`,
          storyJson,
        );
      }
      await executor.run(
        `INSERT INTO quest (id, title, description, genre, available, story_json)
         VALUES ('hidden-page', 'Hidden', '', 'Скрытый', 0, ?)`,
        storyJson,
      );
    });

    const catalog = createTursoQuestCatalog(database);
    const firstQuests = await catalog.listQuestsPage(1);
    expect(firstQuests).toMatchObject({ page: 1, totalItems: 12, totalPages: 3 });
    expect(firstQuests.items).toHaveLength(5);
    expect((await catalog.listQuestsPage(99)).page).toBe(3);
    expect((await catalog.listQuestsPage(1, "Приключения")).totalItems).toBe(7);
    const firstGenres = await catalog.listGenresPage(1);
    expect(firstGenres).toMatchObject({ page: 1, totalItems: 6, totalPages: 2 });
    expect(firstGenres.items).toHaveLength(5);
    const secondGenres = await catalog.listGenresPage(2);
    const adventure = [...firstGenres.items, ...secondGenres.items].find((genre) => genre.name === "Приключения");
    expect(adventure).toBeDefined();
    expect(await catalog.resolveGenreKey(adventure!.key)).toBe("Приключения");
    expect(await catalog.resolveGenreKey("invalid-key")).toBeNull();
    expect(await catalog.listQuestsPage(1, "Скрытый")).toMatchObject({ items: [], totalItems: 0, totalPages: 0 });
  });

  it("does not overwrite an existing demo when its published metadata changes", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await ensureDemoCatalog(database);
    await database.write(async (executor) => {
      await executor.run(
        `UPDATE quest SET title = ?, description = ?, available = 0, story_json = ?
          WHERE id = ?`,
        "Published title",
        "Published description",
        "{\"inkVersion\":21}",
        demoQuestId,
      );
    });

    const before = await readSeedRows(database);
    await ensureDemoCatalog(database);
    expect(await readSeedRows(database)).toEqual(before);
  });

  it("reads the stored compiled story by quest ID and reports missing content", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await ensureDemoCatalog(database);
    const storySource = createTursoStorySource(database);

    const story = await storySource.load(demoQuestId);
    expect(JSON.parse(story)).toBeTypeOf("object");
    await expect(storySource.load("missing-quest"))
      .rejects.toMatchObject<Partial<StorySourceError>>({ code: "NOT_FOUND" });
  });
});
