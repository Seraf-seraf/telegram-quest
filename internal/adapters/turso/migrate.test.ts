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
  it("migrates an empty v0 database to v2", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await ensureSchema(database);

      expect(await readVersion(database)).toBe(2);
      expect(await readTableNames(database)).toEqual([
        "processed_update",
        "quest",
        "quest_version",
        "session",
        "turn",
        "vote",
      ]);
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

  it("migrates a supported v1 database to v2", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await seedVersionOne(database);
      expect(await readVersion(database)).toBe(1);

      await ensureSchema(database);

      expect(await readVersion(database)).toBe(2);
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

  it("leaves a v2 schema unchanged", async () => {
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
      expect(await readVersion(database)).toBe(2);
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

  it("refuses a negative user_version even if the tables match v2", async () => {
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
      expect(await readVersion(database)).toBe(2);
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

      expect(await readVersion(firstDatabase)).toBe(2);
      expect(await readTableNames(firstDatabase)).toHaveLength(6);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("enforces RESTRICT and CASCADE using real SQLite writes", async () => {
    const { directory, database } = await createTemporaryDatabase();

    try {
      await ensureSchema(database);
      await database.write(async (executor) => {
        await executor.run(
          "INSERT INTO quest (id, title, description, genre) VALUES (?, ?, ?, ?)",
          "quest-1",
          "Quest",
          "Description",
          "fantasy",
        );
        await executor.run(
          "INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash) VALUES (?, ?, ?, ?, ?)",
          "version-1",
          "quest-1",
          "1",
          "stories/quest-1.json",
          "hash-1",
        );
        await executor.run(
          "INSERT INTO session (id, quest_version_id, owner_type, owner_id) VALUES (?, ?, ?, ?)",
          "session-1",
          "version-1",
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
      await expect(database.write(async (executor) => {
        await executor.run("DELETE FROM quest WHERE id = ?", "quest-1");
      })).rejects.toThrow();
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
