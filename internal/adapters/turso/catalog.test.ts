import { createHash } from "node:crypto";
import { createClient, type Transaction } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, TursoDatabase } from "./client.js";
import { createTursoQuestCatalog } from "./catalog.js";
import { ensureSchema } from "./migrate.js";
import { DemoCatalogConflictError, ensureDemoCatalog } from "./seed.js";
import { BundledStorySource } from "../ink/bundled-story-source.js";
import { initializeApp } from "../../bootstrap.js";
import type { QuestVersion, SessionOwner } from "../../domain/model.js";
import type { StorySource } from "../../app/story-source.js";
import { StorySourceError } from "../../app/story-source.js";

const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "test-token",
};
const demoQuestId = "telegram-quest-demo";
const demoVersionId = "telegram-quest-demo-v1";
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
  version: SqlRow | undefined;
}> {
  return database.read(async (executor) => ({
    quest: await executor.get(
      "SELECT id, title, description, genre, available FROM quest WHERE id = ?",
      demoQuestId,
    ),
    version: await executor.get(
      "SELECT id, quest_id, version, story_ref, story_hash FROM quest_version WHERE id = ?",
      demoVersionId,
    ),
  }));
}

describe("Turso quest catalog and bundled seed", () => {
  it("bootstraps the bundled quest once and starts it through the real Ink runtime", async () => {
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
    expect(await app.catalog.listVersions(demoQuestId)).toEqual([{
      id: demoVersionId,
      questId: demoQuestId,
      version: "1.0.0",
      storyReference: "bundled:telegram-quest-demo-v1",
      storyHash: expect.stringMatching(/^[a-f\d]{64}$/),
    }]);

    const initial = await app.sessions.createSession(userOwner, demoVersionId, 1);
    const started = await app.sessions.startSession(
      userOwner,
      initial.id,
      initial.stateVersion,
    );
    expect(started.status).toBe("active");
    expect(started.turns[0]?.choices.length).toBeGreaterThan(0);

    const before = await readSeedRows(database);
    await ensureDemoCatalog(database, new BundledStorySource());
    expect(await readSeedRows(database)).toEqual(before);
  });

  it("does not list hidden quests or expose their versions by ID", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await ensureDemoCatalog(database, new BundledStorySource());
    await database.write(async (executor) => {
      await executor.run(
        "INSERT INTO quest (id, title, description, genre, available) VALUES (?, ?, ?, ?, 0)",
        "hidden-quest",
        "Hidden",
        "Not published",
        "adventure",
      );
      await executor.run(
        `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
         VALUES (?, ?, ?, ?, ?)`,
        "hidden-version",
        "hidden-quest",
        "1.0.0",
        "bundled:telegram-quest-demo-v1",
        "a".repeat(64),
      );
    });

    const catalog = createTursoQuestCatalog(database);
    expect((await catalog.listAvailableQuests()).map((quest) => quest.id))
      .toEqual([demoQuestId]);
    expect(await catalog.listVersions("hidden-quest")).toEqual([]);
    expect(await catalog.getQuestVersion("hidden-version")).toBeNull();
  });

  it("returns every available version in a stable order for explicit selection", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await ensureDemoCatalog(database, new BundledStorySource());
    await database.write(async (executor) => {
      await executor.run(
        `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
         VALUES (?, ?, ?, ?, ?)`,
        "telegram-quest-demo-v2",
        demoQuestId,
        "2.0.0",
        "bundled:telegram-quest-demo-v1",
        "c".repeat(64),
      );
    });

    const catalog = createTursoQuestCatalog(database);
    const versions = await catalog.listVersions(demoQuestId);
    expect(versions.map((version) => version.id)).toEqual([
      demoVersionId,
      "telegram-quest-demo-v2",
    ]);
    expect(await catalog.getQuestVersion("telegram-quest-demo-v2"))
      .toMatchObject({ id: "telegram-quest-demo-v2", version: "2.0.0" });
  });

  it("rejects conflicting bundled quest data without rewriting it", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await database.write(async (executor) => {
      await executor.run(
        "INSERT INTO quest (id, title, description, genre, available) VALUES (?, ?, ?, ?, 1)",
        demoQuestId,
        "Different title",
        "Existing content",
        "adventure",
      );
    });

    await expect(ensureDemoCatalog(database, new BundledStorySource()))
      .rejects.toBeInstanceOf(DemoCatalogConflictError);
    const rows = await readSeedRows(database);
    expect(rows.quest).toMatchObject({ title: "Different title", description: "Existing content" });
    expect(rows.version).toBeUndefined();
  });

  it("rejects a conflicting version without changing the existing record", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    await database.write(async (executor) => {
      await executor.run(
        "INSERT INTO quest (id, title, description, genre, available) VALUES (?, ?, ?, ?, 1)",
        demoQuestId,
        "Две двери",
        "Короткий демонстрационный квест с двумя ветвями и финалами.",
        "Приключения",
      );
      await executor.run(
        `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
         VALUES (?, ?, ?, ?, ?)`,
        demoVersionId,
        demoQuestId,
        "1.0.0",
        "bundled:other-story",
        "b".repeat(64),
      );
    });

    await expect(ensureDemoCatalog(database, new BundledStorySource()))
      .rejects.toBeInstanceOf(DemoCatalogConflictError);
    expect((await readSeedRows(database)).version).toMatchObject({
      story_ref: "bundled:other-story",
      story_hash: "b".repeat(64),
    });
  });

  it("stores the hash of the normalized text returned by StorySource", async () => {
    const database = createMemoryDatabase();
    await initializeTestSchema(database);
    const json = await new BundledStorySource().load({
      id: demoVersionId,
      questId: demoQuestId,
      version: "1.0.0",
      storyReference: "bundled:telegram-quest-demo-v1",
      storyHash: "0".repeat(64),
    });
    const source: StorySource = {
      load: async (_version: QuestVersion): Promise<string> => `\uFEFF${json}`,
    };

    await ensureDemoCatalog(database, source);
    const row = (await readSeedRows(database)).version;
    expect(row?.story_hash).toBe(createHash("sha256").update(json).digest("hex"));
  });

  it("loads only the statically bundled story reference", async () => {
    const storySource = new BundledStorySource();
    const version: QuestVersion = {
      id: demoVersionId,
      questId: demoQuestId,
      version: "1.0.0",
      storyReference: "bundled:telegram-quest-demo-v1",
      storyHash: "0".repeat(64),
    };
    const story = await storySource.load(version);
    expect(JSON.parse(story)).toBeTypeOf("object");

    await expect(storySource.load({ ...version, storyReference: "file:///etc/passwd" }))
      .rejects.toMatchObject<Partial<StorySourceError>>({ code: "NOT_FOUND" });
  });
});
