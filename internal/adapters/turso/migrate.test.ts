import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Transaction } from "@libsql/client";
import { describe, expect, it } from "vitest";
import {
  createTursoDatabase,
  type SqlExecutor,
  type SqlRow,
  type TursoDatabase,
} from "./client.js";
import { ensureSchema } from "./migrate.js";
import demoStory from "../ink/fixtures/demo.ink.json" with { type: "json" };
import { InkStoryRuntime } from "../ink/runtime.js";
import { createTursoStorySource } from "./story-source.js";
import { createTursoSessionStore } from "./store.js";
import { SessionService } from "../../app/sessions.js";
import type { SessionOwner } from "../../domain/model.js";

const testStorageConfig = {
  databaseUrl: "libsql://quest-example.turso.io",
  authToken: "test-token",
};

class LocalFileDatabase implements TursoDatabase {
  private client: ReturnType<typeof createClient>;
  private readonly fileUrl: string;

  public constructor(fileUrl: string) {
    this.fileUrl = fileUrl;
    this.client = createClient({ url: fileUrl, concurrency: 1, timeout: 100 });
  }

  public close(): void {
    this.client.close();
  }

  public async read<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    await this.enableAndVerifyForeignKeys();
    return operation({
      all: async (sql, ...args) => {
        const result = await this.client.execute({ sql, args: [...args] });
        return result.rows as unknown as SqlRow[];
      },
      exec: async (sql) => {
        await this.client.executeMultiple(sql);
      },
      get: async (sql, ...args) => {
        const result = await this.client.execute({ sql, args: [...args] });
        return result.rows[0] as unknown as SqlRow | undefined;
      },
      run: async (sql, ...args) => {
        await this.client.execute({ sql, args: [...args] });
      },
    });
  }

  public async write<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    await this.enableAndVerifyForeignKeys();
    let transaction: Transaction;

    try {
      transaction = await this.client.transaction("write");
    } catch (error) {
      this.reopenClient();
      throw error;
    }

    let recreateClient = false;
    try {
      const foreignKeys = await transaction.execute("PRAGMA foreign_keys");

      if (Number(foreignKeys.rows[0]?.foreign_keys) !== 1) {
        throw new Error("Local SQLite transaction did not enable foreign keys.");
      }

      const executor: SqlExecutor = {
        all: async (sql, ...args) => {
          const result = await transaction.execute({ sql, args: [...args] });
          return result.rows as unknown as SqlRow[];
        },
        exec: async (sql) => {
          await transaction.executeMultiple(sql);
        },
        get: async (sql, ...args) => {
          const result = await transaction.execute({ sql, args: [...args] });
          return result.rows[0] as unknown as SqlRow | undefined;
        },
        run: async (sql, ...args) => {
          await transaction.execute({ sql, args: [...args] });
        },
      };
      const result = await operation(executor);
      await transaction.commit();
      return result;
    } catch (error) {
      if (!transaction.closed) {
        await transaction.rollback();
      }

      recreateClient = true;
      throw error;
    } finally {
      transaction.close();

      if (recreateClient) {
        this.reopenClient();
      }
    }
  }

  private async enableAndVerifyForeignKeys(): Promise<void> {
    await this.client.execute("PRAGMA foreign_keys = ON");
    const result = await this.client.execute("PRAGMA foreign_keys");

    if (Number(result.rows[0]?.foreign_keys) !== 1) {
      throw new Error("Local SQLite connection did not enable foreign keys.");
    }
  }

  private reopenClient(): void {
    this.client.close();
    this.client = createClient({
      url: this.fileUrl,
      concurrency: 1,
      timeout: 100,
    });
  }
}

async function createTemporaryDatabase(): Promise<{
  directory: string;
  database: LocalFileDatabase;
}> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-quest-turso-"));
  const fileUrl = pathToFileURL(join(directory, "quest.db")).href;
  return { directory, database: new LocalFileDatabase(fileUrl) };
}

async function readVersion(database: TursoDatabase): Promise<number> {
  return database.read(async (executor) => {
    const row = await executor.get("PRAGMA user_version");
    return Number(row?.user_version);
  });
}

async function readTableNames(database: TursoDatabase): Promise<string[]> {
  return database.read(async (executor) => {
    const rows = await executor.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name",
    );
    return rows.map((row) => String(row.name));
  });
}

async function seedVersionOne(
  database: TursoDatabase,
  migrationOverride?: string,
): Promise<void> {
  const initialSql = migrationOverride ?? await readFile(
    new URL("./migrations/001_initial.sql", import.meta.url),
    "utf8",
  );
  const statements = initialSql
    .replace(/--[^\r\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !/^(?:PRAGMA|BEGIN|COMMIT)\b/i.test(statement));

  await database.write(async (executor) => {
    await executor.exec(statements.map((statement) => `${statement};`).join("\n"));
    await executor.run("PRAGMA user_version = 1");
  });
}

async function seedVersionTwo(database: TursoDatabase): Promise<void> {
  await seedVersionOne(database);
  const terminalOutputSql = await readFile(
    new URL("./migrations/002_terminal_output.sql", import.meta.url),
    "utf8",
  );
  await database.write(async (executor) => {
    await executor.exec(terminalOutputSql);
    await executor.run("PRAGMA user_version = 2");
    await executor.exec(
      "CREATE TABLE quest_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version >= 1))",
    );
    await executor.run("INSERT INTO quest_schema_version (id, version) VALUES (1, 2)");
  });
}

function wrapDatabase(
  database: TursoDatabase,
  wrapExecutor: (executor: SqlExecutor) => SqlExecutor,
): TursoDatabase {
  return {
    close: () => database.close(),
    read: (operation) => database.read((executor) => operation(wrapExecutor(executor))),
    write: (operation) => database.write((executor) => operation(wrapExecutor(executor))),
  };
}

describe("ensureSchema with local libSQL", () => {
  it("initializes when the database rejects writes to PRAGMA user_version", async () => {
    const { directory, database } = await createTemporaryDatabase();
    const restrictedDatabase = wrapDatabase(database, (executor) => ({
      ...executor,
      run: async (sql, ...args) => {
        if (/^PRAGMA\s+user_version\s*=/i.test(sql)) {
          throw new Error("SQL not allowed statement: PRAGMA user_version");
        }
        await executor.run(sql, ...args);
      },
    }));

    try {
      await ensureSchema(restrictedDatabase);
      await ensureSchema(restrictedDatabase);
      const row = await database.read((executor) => executor.get(
        "SELECT version FROM quest_schema_version WHERE id = 1",
      ));
      expect(Number(row?.version)).toBe(3);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates an empty v0 database to v3", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await ensureSchema(database);

      expect(await readVersion(database)).toBe(0);
      expect(await readTableNames(database)).toEqual([
        "processed_update",
        "quest",
        "quest_schema_version",
        "session",
        "turn",
        "vote",
      ]);
      const questColumns = await database.read(async (executor) => {
        const rows = await executor.all("PRAGMA table_info(quest)");
        return rows.map((row) => row.name);
      });
      expect(questColumns).toContain("story_json");
      const sessionColumns = await database.read(async (executor) => {
        const rows = await executor.all("PRAGMA table_info(session)");
        return rows.map((row) => row.name);
      });
      expect(sessionColumns).toContain("final_scene_text");
      expect(sessionColumns).toContain("final_scene_tags_json");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates a supported v1 database to v3", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await seedVersionOne(database);
      expect(await readVersion(database)).toBe(1);

      await ensureSchema(database);
      await ensureSchema(database);

      expect(await readVersion(database)).toBe(1);
      expect(await readTableNames(database)).toContain("quest_schema_version");
      const sessionColumns = await database.read(async (executor) => {
        const rows = await executor.all("PRAGMA table_info(session)");
        return rows.map((row) => row.name);
      });
      expect(sessionColumns).toContain("final_scene_text");
      expect(sessionColumns).toContain("final_scene_tags_json");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts and migrates an existing v2 database after validating its schema", async () => {
    const { directory, database } = await createTemporaryDatabase();
    try {
      await seedVersionTwo(database);
      await ensureSchema(database);
      expect(await readVersion(database)).toBe(2);
      expect(await readTableNames(database)).toContain("quest_schema_version");
      const row = await database.read((executor) => executor.get(
        "SELECT version FROM quest_schema_version WHERE id = 1",
      ));
      expect(Number(row?.version)).toBe(3);
      expect(await readTableNames(database)).not.toContain("quest_version");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates saved sessions, turns, votes, and updates and resumes the hidden quest", async () => {
    const { directory, database } = await createTemporaryDatabase();
    const compiledStoryJson = JSON.stringify(demoStory);
    const storyHash = createHash("sha256").update(compiledStoryJson).digest("hex");
    const runtime = new InkStoryRuntime();
    const initial = runtime.start(compiledStoryJson);
    const branch = runtime.choose(compiledStoryJson, initial.stateJson, 0);
    const ending = runtime.choose(compiledStoryJson, branch.stateJson, 0);
    const oldEnvelope = (inkStateJson: string): string => JSON.stringify({
      formatVersion: 1,
      storyFingerprint: storyHash,
      inkStateJson,
    });
    const initialEnvelope = oldEnvelope(initial.stateJson);
    const branchEnvelope = oldEnvelope(branch.stateJson);
    const endingEnvelope = oldEnvelope(ending.stateJson);
    const choicesJson = JSON.stringify(initial.choices);
    const branchChoicesJson = JSON.stringify(branch.choices);

    try {
      await seedVersionTwo(database);
      await database.write(async (executor) => {
        await executor.run(
          `INSERT INTO quest (id, title, description, genre, available)
           VALUES (?, ?, ?, ?, 0)`,
          "telegram-quest-demo",
          "Published title",
          "Published description",
          "Mystery",
        );
        await executor.run(
          `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
           VALUES (?, ?, ?, ?, ?)`,
          "demo-version-one",
          "telegram-quest-demo",
          "1.0.0",
          "bundled:telegram-quest-demo-v1",
          storyHash,
        );
        await executor.run(
          `INSERT INTO session (id, quest_version_id, owner_type, owner_id)
           VALUES (?, ?, 'user', 'created-owner')`,
          "session-created",
          "demo-version-one",
        );
        await executor.run(
          `INSERT INTO session (
             id, quest_version_id, owner_type, owner_id, status, ink_state_json,
             state_version, menu_message_id
           ) VALUES (?, ?, 'user', 'active-owner', 'active', ?, 3, 5001)`,
          "session-active",
          "demo-version-one",
          initialEnvelope,
        );
        await executor.run(
          `INSERT INTO session (
             id, quest_version_id, owner_type, owner_id, status, ink_state_json,
             state_version, menu_message_id
           ) VALUES (?, ?, 'user', 'paused-owner', 'paused', ?, 4, 5002)`,
          "session-paused",
          "demo-version-one",
          initialEnvelope,
        );
        await executor.run(
          `INSERT INTO session (
             id, quest_version_id, owner_type, owner_id, status, ink_state_json,
             state_version, outcome, menu_message_id, final_scene_text, final_scene_tags_json
           ) VALUES (?, ?, 'user', 'completed-owner', 'completed', ?, 5,
                     'story_completed', 5003, ?, ?)`,
          "session-completed",
          "demo-version-one",
          endingEnvelope,
          ending.text,
          JSON.stringify(ending.tags),
        );
        await executor.run(
          `INSERT INTO turn (
             id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
             interactive_message_id
           ) VALUES (?, ?, 1, ?, ?, ?, 7001)`,
          "turn-active",
          "session-active",
          initialEnvelope,
          initial.text,
          choicesJson,
        );
        await executor.run(
          `INSERT INTO turn (
             id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
             default_choice_index, vote_duration_ms, remaining_ms, interactive_message_id
           ) VALUES (?, ?, 1, ?, ?, ?, 0, 60000, 40000, 7002)`,
          "turn-paused",
          "session-paused",
          initialEnvelope,
          initial.text,
          choicesJson,
        );
        await executor.run(
          `INSERT INTO turn (
             id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
             decision_choice_index, interactive_message_id
           ) VALUES (?, ?, 2, ?, ?, ?, 0, 7003)`,
          "turn-completed",
          "session-completed",
          branchEnvelope,
          branch.text,
          branchChoicesJson,
        );
        await executor.run(
          "INSERT INTO vote (turn_id, voter_id, choice_index, cast_at_ms) VALUES (?, ?, ?, ?)",
          "turn-active",
          "voter-1",
          0,
          1234,
        );
        await executor.run(
          "INSERT INTO processed_update (update_id, processed_at_ms) VALUES (?, ?)",
          101,
          1111,
        );
        await executor.run(
          "INSERT INTO processed_update (update_id, processed_at_ms) VALUES (?, ?)",
          102,
          2222,
        );
      });

      await ensureSchema(database);

      const migrated = await database.read(async (executor) => ({
        quest: await executor.get(
          "SELECT id, title, description, genre, available, story_json FROM quest WHERE id = ?",
          "telegram-quest-demo",
        ),
        sessions: await executor.all(
          `SELECT id, quest_id, owner_type, owner_id, status, ink_state_json, state_version,
                  outcome, menu_message_id, final_scene_text, final_scene_tags_json
             FROM session ORDER BY id`,
        ),
        turns: await executor.all(
          `SELECT id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
                  default_choice_index, vote_duration_ms, deadline_at_ms, remaining_ms,
                  decision_choice_index, interactive_message_id FROM turn ORDER BY id`,
        ),
        votes: await executor.all("SELECT turn_id, voter_id, choice_index, cast_at_ms FROM vote"),
        updates: await executor.all(
          "SELECT update_id, processed_at_ms FROM processed_update ORDER BY update_id",
        ),
        versions: await executor.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quest_version'"),
        fk: await executor.all("PRAGMA foreign_key_check"),
      }));
      expect(migrated.quest).toMatchObject({
        title: "Published title",
        description: "Published description",
        genre: "Mystery",
        available: 0,
        story_json: compiledStoryJson,
      });
      expect(migrated.sessions).toMatchObject([
        { id: "session-active", quest_id: "telegram-quest-demo", status: "active", ink_state_json: initial.stateJson, state_version: 3, menu_message_id: 5001 },
        { id: "session-completed", quest_id: "telegram-quest-demo", status: "completed", ink_state_json: ending.stateJson, outcome: "story_completed", menu_message_id: 5003, final_scene_text: ending.text, final_scene_tags_json: JSON.stringify(ending.tags) },
        { id: "session-created", quest_id: "telegram-quest-demo", status: "created", ink_state_json: null, state_version: 0 },
        { id: "session-paused", quest_id: "telegram-quest-demo", status: "paused", ink_state_json: initial.stateJson, state_version: 4, menu_message_id: 5002 },
      ]);
      expect(migrated.turns).toMatchObject([
        { id: "turn-active", ink_checkpoint_json: initial.stateJson, interactive_message_id: 7001 },
        { id: "turn-completed", ink_checkpoint_json: branch.stateJson, decision_choice_index: 0, interactive_message_id: 7003 },
        { id: "turn-paused", ink_checkpoint_json: initial.stateJson, default_choice_index: 0, vote_duration_ms: 60000, remaining_ms: 40000, interactive_message_id: 7002 },
      ]);
      expect(migrated.votes).toEqual([
        { turn_id: "turn-active", voter_id: "voter-1", choice_index: 0, cast_at_ms: 1234 },
      ]);
      expect(migrated.updates).toEqual([
        { update_id: 101, processed_at_ms: 1111 },
        { update_id: 102, processed_at_ms: 2222 },
      ]);
      expect(migrated.versions).toEqual([]);
      expect(migrated.fk).toEqual([]);

      const owner: SessionOwner = { type: "user", id: "active-owner" };
      const turnIds = ["turn-after-migration", "turn-after-rewind"];
      let turnIdIndex = 0;
      const sessions = new SessionService({
        store: createTursoSessionStore(database),
        storyRuntime: new InkStoryRuntime(),
        storySource: createTursoStorySource(database),
        newId: () => {
          const id = turnIds[turnIdIndex];
          if (id === undefined) {
            throw new Error("Test turn ID sequence is exhausted.");
          }
          turnIdIndex += 1;
          return id;
        },
      });
      const active = await sessions.getSession(owner, "session-active");
      const currentTurn = active.turns[0];
      if (currentTurn === undefined) {
        throw new Error("Migrated active session has no current turn.");
      }
      const continued = await sessions.applyDecision(
        owner,
        active.id,
        currentTurn.id,
        0,
        active.stateVersion,
        900,
      );
      expect(continued.turns[0]?.sceneText).toContain("The left path glows.");
      const rewound = await sessions.rewindSession(
        owner,
        continued.id,
        1,
        continued.stateVersion,
      );
      expect(rewound.turns[0]).toMatchObject({ stepNumber: 1, decision: null });
      expect(rewound.inkState).toBe(initial.stateJson);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous quest stories without changing the v2 database", async () => {
    const { directory, database } = await createTemporaryDatabase();
    const compiledStoryJson = JSON.stringify(demoStory);
    const storyHash = createHash("sha256").update(compiledStoryJson).digest("hex");

    try {
      await seedVersionTwo(database);
      await database.write(async (executor) => {
        await executor.run(
          "INSERT INTO quest (id, title, description, genre) VALUES (?, ?, ?, ?)",
          "telegram-quest-demo",
          "Demo",
          "Description",
          "Mystery",
        );
        await executor.run(
          `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
           VALUES (?, ?, ?, ?, ?)`,
          "demo-version-one",
          "telegram-quest-demo",
          "1.0.0",
          "bundled:telegram-quest-demo-v1",
          storyHash,
        );
        await executor.run(
          `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
           VALUES (?, ?, ?, ?, ?)`,
          "demo-version-two",
          "telegram-quest-demo",
          "2.0.0",
          "bundled:telegram-quest-demo-v1",
          "a".repeat(64),
        );
      });

      await expect(ensureSchema(database)).rejects.toThrow("ambiguous story versions");
      expect(await readTableNames(database)).toContain("quest_version");
      expect(await readTableNames(database)).not.toContain("quest_new");
      const state = await database.read(async (executor) => ({
        versions: await executor.get("SELECT count(*) AS count FROM quest_version"),
        marker: await executor.get("SELECT version FROM quest_schema_version WHERE id = 1"),
      }));
      expect(Number(state.versions?.count)).toBe(2);
      expect(Number(state.marker?.version)).toBe(2);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unknown story source without modifying the old content", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await seedVersionTwo(database);
      await database.write(async (executor) => {
        await executor.run(
          "INSERT INTO quest (id, title, description, genre) VALUES (?, ?, ?, ?)",
          "custom-quest",
          "Custom",
          "Unknown source",
          "Mystery",
        );
        await executor.run(
          `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
           VALUES (?, ?, ?, ?, ?)`,
          "custom-version",
          "custom-quest",
          "1.0.0",
          "https://stories.example/custom.json",
          "b".repeat(64),
        );
      });

      await expect(ensureSchema(database)).rejects.toThrow("cannot resolve the story");
      expect(await readTableNames(database)).toContain("quest_version");
      const state = await database.read(async (executor) => ({
        quest: await executor.get("SELECT id FROM quest WHERE id = ?", "custom-quest"),
        version: await executor.get("SELECT id, story_ref FROM quest_version WHERE id = ?", "custom-version"),
        marker: await executor.get("SELECT version FROM quest_schema_version WHERE id = 1"),
      }));
      expect(state.quest).toEqual({ id: "custom-quest" });
      expect(state.version).toEqual({
        id: "custom-version",
        story_ref: "https://stories.example/custom.json",
      });
      expect(Number(state.marker?.version)).toBe(2);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the v3 table rebuild after a copy failure", async () => {
    const { directory, database } = await createTemporaryDatabase();
    const compiledStoryJson = JSON.stringify(demoStory);
    const storyHash = createHash("sha256").update(compiledStoryJson).digest("hex");
    const failQuestCopy = wrapDatabase(database, (executor) => ({
      ...executor,
      run: async (sql, ...args) => {
        if (sql.startsWith("INSERT INTO quest_new")) {
          throw new Error("simulated v3 copy failure");
        }
        await executor.run(sql, ...args);
      },
    }));

    try {
      await seedVersionTwo(database);
      await database.write(async (executor) => {
        await executor.run(
          "INSERT INTO quest (id, title, description, genre) VALUES (?, ?, ?, ?)",
          "telegram-quest-demo",
          "Demo",
          "Description",
          "Mystery",
        );
        await executor.run(
          `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
           VALUES (?, ?, ?, ?, ?)`,
          "demo-version-one",
          "telegram-quest-demo",
          "1.0.0",
          "bundled:telegram-quest-demo-v1",
          storyHash,
        );
      });

      await expect(ensureSchema(failQuestCopy)).rejects.toThrow("simulated v3 copy failure");
      expect(await readTableNames(database)).toContain("quest_version");
      expect(await readTableNames(database)).not.toContain("quest_new");
      const marker = await database.read((executor) => executor.get(
        "SELECT version FROM quest_schema_version WHERE id = 1",
      ));
      expect(Number(marker?.version)).toBe(2);

      await ensureSchema(database);
      const upgraded = await database.read((executor) => executor.get(
        "SELECT version FROM quest_schema_version WHERE id = 1",
      ));
      expect(Number(upgraded?.version)).toBe(3);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an invalid stored schema version without modifying it", async () => {
    const { directory, database } = await createTemporaryDatabase();
    try {
      await ensureSchema(database);
      await database.write((executor) => executor.run(
        "UPDATE quest_schema_version SET version = 4 WHERE id = 1",
      ));
      await expect(ensureSchema(database)).rejects.toThrow("unsupported version");
      const row = await database.read((executor) => executor.get(
        "SELECT version FROM quest_schema_version WHERE id = 1",
      ));
      expect(Number(row?.version)).toBe(4);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves a v3 schema unchanged", async () => {
    const { directory, database } = await createTemporaryDatabase();
    let execCalls = 0;
    let runCalls = 0;

    try {
      await ensureSchema(database);
      const noMutationDatabase = wrapDatabase(database, (executor) => ({
        ...executor,
        exec: async (sql) => {
          execCalls += 1;
          await executor.exec(sql);
        },
        run: async (sql, ...args) => {
          runCalls += 1;
          await executor.run(sql, ...args);
        },
      }));

      await ensureSchema(noMutationDatabase);

      expect(execCalls).toBe(0);
      expect(runCalls).toBe(0);
      expect(await readVersion(database)).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses populated unversioned databases without modifying them", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await database.write(async (executor) => {
        await executor.exec("CREATE TABLE custom_data (id TEXT PRIMARY KEY)");
      });

      await expect(ensureSchema(database)).rejects.toThrow("unversioned schema objects");

      expect(await readVersion(database)).toBe(0);
      expect(await readTableNames(database)).toEqual(["custom_data"]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unversioned database containing only a view", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await database.write(async (executor) => {
        await executor.exec("CREATE VIEW existing_view AS SELECT 1 AS value");
      });

      await expect(ensureSchema(database)).rejects.toThrow("unversioned schema objects");
      expect(await readVersion(database)).toBe(0);
      expect(await readTableNames(database)).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not treat user objects beginning with sqlite but not sqlite_ as internal", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await database.write(async (executor) => {
        await executor.exec("CREATE VIEW sqliteFoo AS SELECT 1 AS value");
      });

      await expect(ensureSchema(database)).rejects.toThrow("unversioned schema objects");
      expect(await readVersion(database)).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a versioned schema whose foreign-key definition changed", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      const initialSql = await readFile(
        new URL("./migrations/001_initial.sql", import.meta.url),
        "utf8",
      );
      const alteredSql = initialSql.replace(
        "REFERENCES session(id) ON DELETE CASCADE",
        "REFERENCES session(id) ON DELETE RESTRICT",
      );
      expect(alteredSql).not.toBe(initialSql);
      await seedVersionOne(database, alteredSql);

      await expect(ensureSchema(database)).rejects.toThrow(
        "unsupported definition for turn",
      );
      expect(await readVersion(database)).toBe(1);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves string literal case while validating schema definitions", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      const initialSql = await readFile(
        new URL("./migrations/001_initial.sql", import.meta.url),
        "utf8",
      );
      const alteredSql = initialSql.replace(
        "'group', 'user'",
        "'GROUP', 'USER'",
      );
      expect(alteredSql).not.toBe(initialSql);
      await seedVersionOne(database, alteredSql);

      await expect(ensureSchema(database)).rejects.toThrow(
        "unsupported definition for session",
      );
      expect(await readVersion(database)).toBe(1);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a negative user_version even if the tables match v3", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await ensureSchema(database);
      await database.write(async (executor) => {
        await executor.run("PRAGMA user_version = -1");
      });

      await expect(ensureSchema(database)).rejects.toThrow("schema version -1 is invalid");
      expect(await readVersion(database)).toBe(-1);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses schema versions newer than this application supports", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await database.write(async (executor) => {
        await executor.run("PRAGMA user_version = 3");
      });

      await expect(ensureSchema(database)).rejects.toThrow("newer than this application supports");
      expect(await readVersion(database)).toBe(3);
      expect(await readTableNames(database)).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back every schema change after a failed migration and can retry", async () => {
    const { directory, database } = await createTemporaryDatabase();
    let execCalls = 0;
    const failSecondMigration = wrapDatabase(database, (executor) => ({
      ...executor,
      exec: async (sql) => {
        execCalls += 1;

        if (execCalls === 2) {
          throw new Error("simulated v2 migration failure");
        }

        await executor.exec(sql);
      },
    }));

    try {
      await expect(ensureSchema(failSecondMigration)).rejects.toThrow(
        "simulated v2 migration failure",
      );
      expect(await readVersion(database)).toBe(0);
      expect(await readTableNames(database)).toEqual([]);

      await ensureSchema(database);
      expect(await readVersion(database)).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back schema changes when storing the version fails", async () => {
    const { directory, database } = await createTemporaryDatabase();
    const failingDatabase = wrapDatabase(database, (executor) => ({
      ...executor,
      run: async (sql, ...args) => {
        if (sql.startsWith("INSERT INTO quest_schema_version")) {
          throw new Error("simulated version marker failure");
        }
        await executor.run(sql, ...args);
      },
    }));
    try {
      await expect(ensureSchema(failingDatabase)).rejects.toThrow("version marker failure");
      expect(await readVersion(database)).toBe(0);
      expect(await readTableNames(database)).toEqual([]);
      await ensureSchema(database);
      expect(await readTableNames(database)).toContain("quest_schema_version");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes two independent clients initializing the same file", async () => {
    const { directory, database: firstDatabase } = await createTemporaryDatabase();
    const secondDatabase = new LocalFileDatabase(
      pathToFileURL(join(directory, "quest.db")).href,
    );

    try {
      await Promise.all([
        ensureSchema(firstDatabase),
        ensureSchema(secondDatabase),
      ]);

      expect(await readVersion(firstDatabase)).toBe(0);
      expect(await readTableNames(firstDatabase)).toHaveLength(6);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("enforces quest RESTRICT and turn and vote CASCADE using real SQLite writes", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await ensureSchema(database);
      await database.write(async (executor) => {
        await executor.run(
          `INSERT INTO quest (id, title, description, genre, story_json)
           VALUES (?, ?, ?, ?, ?)`,
          "quest-1",
          "Quest",
          "Description",
          "fantasy",
          "{\"inkVersion\":21}",
        );
        await executor.run(
          "INSERT INTO session (id, quest_id, owner_type, owner_id) VALUES (?, ?, ?, ?)",
          "session-1",
          "quest-1",
          "group",
          "-1001",
        );
        await executor.run(
          "INSERT INTO turn (id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json) VALUES (?, ?, ?, ?, ?, ?)",
          "turn-1",
          "session-1",
          1,
          "{}",
          "A scene",
          '[{"index":0,"text":"Continue","tags":[]}]',
        );
        await executor.run(
          "INSERT INTO vote (turn_id, voter_id, choice_index, cast_at_ms) VALUES (?, ?, ?, ?)",
          "turn-1",
          "user-1",
          0,
          1,
        );
      });

      await expect(database.write(async (executor) => {
        await executor.run("DELETE FROM quest WHERE id = ?", "quest-1");
      })).rejects.toThrow();

      await database.write(async (executor) => {
        await executor.run("DELETE FROM session WHERE id = ?", "session-1");
      });

      const cascadeCounts = await database.read(async (executor) => ({
        turns: await executor.get("SELECT count(*) AS count FROM turn"),
        votes: await executor.get("SELECT count(*) AS count FROM vote"),
      }));
      expect(Number(cascadeCounts.turns?.count)).toBe(0);
      expect(Number(cascadeCounts.votes?.count)).toBe(0);
      await database.write(async (executor) => {
        await executor.run("DELETE FROM quest WHERE id = ?", "quest-1");
      });
      const remainingQuest = await database.read((executor) => executor.get(
        "SELECT id FROM quest WHERE id = ?",
        "quest-1",
      ));
      expect(remainingQuest).toBeUndefined();
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class FakeTursoConnection implements SqlExecutor {
  public inTransaction = false;
  public closed = false;

  public constructor(
    private readonly events: string[],
    private readonly foreignKeyValue = 1,
  ) {}

  public async all(): Promise<SqlRow[]> {
    this.events.push("all");
    return [];
  }

  public async close(): Promise<void> {
    this.events.push("close");
    this.closed = true;
  }

  public async exec(sql: string): Promise<void> {
    this.events.push(`exec:${sql}`);

    if (sql === "BEGIN IMMEDIATE") {
      this.inTransaction = true;
    } else if (sql === "COMMIT" || sql === "ROLLBACK") {
      this.inTransaction = false;
    }
  }

  public async get(sql: string): Promise<SqlRow | undefined> {
    this.events.push(`get:${sql}`);
    return sql === "PRAGMA foreign_keys"
      ? { foreign_keys: this.foreignKeyValue }
      : undefined;
  }

  public async pragma(pragma: string): Promise<void> {
    this.events.push(`pragma:${pragma}`);
  }

  public async run(): Promise<void> {
    this.events.push("run");
  }
}

describe("createTursoDatabase", () => {
  it("enables and verifies foreign keys on the same stream before beginning", async () => {
    const events: string[] = [];
    const connection = new FakeTursoConnection(events);
    const database = createTursoDatabase(testStorageConfig, () => connection);

    await database.write(async () => {
      events.push("operation");
    });

    expect(events).toEqual([
      "pragma:foreign_keys = ON",
      "get:PRAGMA foreign_keys",
      "exec:BEGIN IMMEDIATE",
      "operation",
      "exec:COMMIT",
      "close",
    ]);
    expect(connection.closed).toBe(true);
  });

  it("refuses to begin if foreign-key enforcement cannot be verified", async () => {
    const events: string[] = [];
    const connection = new FakeTursoConnection(events, 0);
    const database = createTursoDatabase(testStorageConfig, () => connection);

    await expect(database.write(async () => undefined)).rejects.toThrow(
      "did not enable foreign-key enforcement",
    );

    expect(events).toEqual([
      "pragma:foreign_keys = ON",
      "get:PRAGMA foreign_keys",
      "close",
    ]);
  });

  it("rolls back a failed callback and gives concurrent writes private streams", async () => {
    const events: string[] = [];
    const connections: FakeTursoConnection[] = [];
    const database = createTursoDatabase(testStorageConfig, () => {
      const connection = new FakeTursoConnection(events);
      connections.push(connection);
      return connection;
    });
    const expectedError = new Error("failed transaction callback");

    await expect(database.write(async () => {
      throw expectedError;
    })).rejects.toBe(expectedError);

    await Promise.all([
      database.write(async () => undefined),
      database.write(async () => undefined),
    ]);

    expect(events).toContain("exec:ROLLBACK");
    expect(connections).toHaveLength(3);
    expect(connections.every((connection) => connection.closed)).toBe(true);
  });
});
