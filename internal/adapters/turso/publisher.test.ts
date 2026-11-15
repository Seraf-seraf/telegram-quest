import { createClient, type Transaction } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "../../app/sessions.js";
import { assetReferences, resolveContent } from "../../app/content.js";
import type { Quest } from "../../domain/model.js";
import { InkStoryRuntime } from "../ink/runtime.js";
import { compileInkStory } from "../ink/compiler.js";
import { createTursoMetadataStore } from "./metadata.js";
import { createTursoSessionStore } from "./store.js";
import { createTursoStorySource } from "./story-source.js";
import { ensureSchema } from "./migrate.js";
import { createTursoQuestPublisher } from "./publisher.js";
import type { SqlExecutor, SqlRow, TursoDatabase } from "./client.js";

const testQuest: Quest = {
  id: "two-doors",
  title: "Две двери",
  description: "Короткая история",
  genre: "Мистика",
  available: true,
};
const compiledStory = JSON.stringify({ inkVersion: 21, root: [], listDefs: {} });
const openDatabases = new Set<TursoDatabase>();

function createMemoryDatabase(): TursoDatabase {
  const client = createClient({ url: "file::memory:", concurrency: 1 });
  let closed = false;

  function makeExecutor(connection: ReturnType<typeof createClient> | Transaction): SqlExecutor {
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
    async read<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("Local test database is closed.");
      }
      await client.execute("PRAGMA foreign_keys = ON");
      return operation(makeExecutor(client));
    },
    async write<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("Local test database is closed.");
      }
      await client.execute("PRAGMA foreign_keys = ON");
      const transaction = await client.transaction("write");
      try {
        const result = await operation(makeExecutor(transaction));
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

describe("createTursoQuestPublisher", () => {
  it("publishes and replaces a quest without duplicates and preserves unlisted metadata", async () => {
    const database = createMemoryDatabase();
    await ensureSchema(database);
    const publisher = createTursoQuestPublisher(database);
    await publisher.publishQuest(testQuest, compiledStory, [
      { name: "cover", value: { kind: "image", value: "https://assets.example/old.jpg" } },
      { name: "note", value: { kind: "text", value: "Visible note." } },
    ]);

    await publisher.publishQuest({
      ...testQuest,
      title: "Обновлённое название",
    }, JSON.stringify({ inkVersion: 21, root: ["recompiled"], listDefs: {} }));

    const rows = await database.read(async (executor) => ({
      quest: await executor.get(
        "SELECT id, title, story_json FROM quest WHERE id = ?",
        testQuest.id,
      ),
      count: await executor.get(
        "SELECT COUNT(*) AS count FROM quest WHERE id = ?",
        testQuest.id,
      ),
      metadata: await executor.all(
        "SELECT name, kind, value FROM content_metadata WHERE quest_id = ? ORDER BY name",
        testQuest.id,
      ),
    }));

    expect(rows.quest).toEqual({
      id: testQuest.id,
      title: "Обновлённое название",
      story_json: JSON.stringify({ inkVersion: 21, root: ["recompiled"], listDefs: {} }),
    });
    expect(Number(rows.count?.count)).toBe(1);
    expect(rows.metadata).toEqual([
      { name: "cover", kind: "image", value: "https://assets.example/old.jpg" },
      { name: "note", kind: "text", value: "Visible note." },
    ]);
  });

  it("updates named metadata atomically and removes only keys set to null", async () => {
    const database = createMemoryDatabase();
    await ensureSchema(database);
    const publisher = createTursoQuestPublisher(database);
    await publisher.publishQuest(testQuest, compiledStory, [
      { name: "cover", value: { kind: "image", value: "https://assets.example/old.jpg" } },
      { name: "note", value: { kind: "text", value: "Old note." } },
    ]);

    await publisher.updateQuestMetadata(
      { ...testQuest, title: "Новое описание" },
      [
        { name: "cover", value: null },
        { name: "note", value: { kind: "text", value: "New note." } },
      ],
    );

    const state = await database.read(async (executor) => ({
      quest: await executor.get("SELECT title, story_json FROM quest WHERE id = ?", testQuest.id),
      metadata: await executor.all(
        "SELECT name, kind, value FROM content_metadata WHERE quest_id = ? ORDER BY name",
        testQuest.id,
      ),
    }));
    expect(state.quest).toEqual({ title: "Новое описание", story_json: compiledStory });
    expect(state.metadata).toEqual([
      { name: "note", kind: "text", value: "New note." },
    ]);
  });

  it("keeps global menu metadata separate from quest metadata", async () => {
    const database = createMemoryDatabase();
    await ensureSchema(database);
    const publisher = createTursoQuestPublisher(database);
    await publisher.publishQuest(testQuest, compiledStory, [
      { name: "cover", value: { kind: "text", value: "Quest cover note." } },
    ]);
    await publisher.publishMenu([
      { name: "cover", value: { kind: "image", value: "https://assets.example/menu.jpg" } },
    ]);

    const rows = await database.read((executor) => executor.all(
      "SELECT quest_id, name, kind, value FROM content_metadata ORDER BY quest_id",
    ));
    expect(rows).toEqual([
      { quest_id: null, name: "cover", kind: "image", value: "https://assets.example/menu.jpg" },
      { quest_id: testQuest.id, name: "cover", kind: "text", value: "Quest cover note." },
    ]);
  });

  it("rolls back quest and metadata writes when a metadata constraint fails", async () => {
    const database = createMemoryDatabase();
    await ensureSchema(database);
    const publisher = createTursoQuestPublisher(database);
    const invalidMetadata = [{
      name: "invalid",
      value: { kind: "" as "text", value: "value" },
    }];

    await expect(publisher.publishQuest(
      { ...testQuest, id: "atomic-quest" },
      compiledStory,
      invalidMetadata,
    )).rejects.toThrow();

    const rows = await database.read(async (executor) => ({
      quest: await executor.get("SELECT id FROM quest WHERE id = ?", "atomic-quest"),
      metadata: await executor.get(
        "SELECT id FROM content_metadata WHERE quest_id = ?",
        "atomic-quest",
      ),
    }));
    expect(rows).toEqual({ quest: undefined, metadata: undefined });
  });

  it("makes a new compiled quest available to start and choose through the real Ink runtime", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "telegram-quest-publisher-"));
    const database = createMemoryDatabase();
    try {
      await writeFile(join(directory, "story.ink"), [
        "-> start",
        "=== start",
        "A door waits.",
        "+ [Open it]",
        "    -> ending",
        "=== ending",
        "The door opens.",
        "-> END",
      ].join("\n"), "utf8");
      const storyJson = await compileInkStory(directory);
      await ensureSchema(database);
      await createTursoQuestPublisher(database).publishQuest(
        { ...testQuest, id: "published-story" },
        storyJson,
      );

      const owner = { type: "user", id: "user-17" } as const;
      const sessions = new SessionService({
        store: createTursoSessionStore(database),
        storyRuntime: new InkStoryRuntime(),
        storySource: createTursoStorySource(database),
      });
      const created = await sessions.createSession(owner, "published-story", 1);
      const started = await sessions.startSession(owner, created.id, created.stateVersion);
      expect(started.turns[0]?.choices[0]?.text).toBe("Open it");
      const completed = await sessions.applyDecision(
        owner,
        started.id,
        started.turns[0]!.id,
        0,
        started.stateVersion,
        2,
      );

      expect(completed.status).toBe("completed");
      expect(completed.finalScene?.text).toContain("The door opens.");
    } finally {
      database.close();
      openDatabases.delete(database);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows an updated image in an active session without changing saved progress", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "telegram-quest-metadata-refresh-"));
    const database = createMemoryDatabase();
    try {
      await writeFile(join(directory, "story.ink"), [
        "-> start",
        "=== start",
        "A door waits. # asset:cover",
        "+ [Continue]",
        "    -> ending",
        "=== ending",
        "The door opens.",
        "-> END",
      ].join("\n"), "utf8");
      const storyJson = await compileInkStory(directory);
      await ensureSchema(database);
      const publisher = createTursoQuestPublisher(database);
      await publisher.publishQuest(
        { ...testQuest, id: "active-metadata-refresh" },
        storyJson,
        [{ name: "cover", value: { kind: "image", value: "https://assets.example/old.jpg" } }],
      );

      const owner = { type: "user", id: "user-18" } as const;
      const sessions = new SessionService({
        store: createTursoSessionStore(database),
        storyRuntime: new InkStoryRuntime(),
        storySource: createTursoStorySource(database),
      });
      const created = await sessions.createSession(owner, "active-metadata-refresh", 1);
      const started = await sessions.startSession(owner, created.id, created.stateVersion);
      const turn = started.turns[0]!;
      const progressBefore = await database.read(async (executor) => ({
        session: await executor.get(
          "SELECT status, state_version, ink_state_json FROM session WHERE id = ?",
          started.id,
        ),
        turn: await executor.get(
          "SELECT step_no, ink_checkpoint_json, scene_tags_json, choices_json FROM turn WHERE id = ?",
          turn.id,
        ),
      }));

      await publisher.updateQuestMetadata(
        { ...testQuest, id: "active-metadata-refresh", title: "Updated" },
        [{ name: "cover", value: { kind: "image", value: "https://assets.example/new.jpg" } }],
      );
      const view = await resolveContent(
        createTursoMetadataStore(database),
        "active-metadata-refresh",
        turn.sceneText,
        assetReferences(turn.sceneTags),
        () => {},
      );
      const progressAfter = await database.read(async (executor) => ({
        session: await executor.get(
          "SELECT status, state_version, ink_state_json FROM session WHERE id = ?",
          started.id,
        ),
        turn: await executor.get(
          "SELECT step_no, ink_checkpoint_json, scene_tags_json, choices_json FROM turn WHERE id = ?",
          turn.id,
        ),
      }));

      expect(view.imageUrl).toBe("https://assets.example/new.jpg");
      expect(progressAfter).toEqual(progressBefore);
      const completed = await sessions.applyDecision(
        owner,
        started.id,
        turn.id,
        0,
        started.stateVersion,
        2,
      );
      expect(completed.status).toBe("completed");
    } finally {
      database.close();
      openDatabases.delete(database);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
