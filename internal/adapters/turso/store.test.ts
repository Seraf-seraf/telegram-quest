import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Transaction } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionOwner } from "../../domain/model.js";
import {
  SessionError,
  type SessionErrorCode,
  type SessionStore,
} from "../../app/session-store.js";
import { SessionService } from "../../app/sessions.js";
import type { StoryRuntime, StoryStep } from "../../app/story.js";
import { StorySourceError, type StorySource } from "../../app/story-source.js";
import { initializeApp, type ReadyApp } from "../../bootstrap.js";
import { InkStoryRuntime } from "../ink/runtime.js";
import type {
  SqlExecutor,
  SqlRow,
  TursoDatabase,
} from "./client.js";
import { ensureSchema } from "./migrate.js";
import { createTursoSessionStore } from "./store.js";

const compiledStoryJson = readFileSync(
  new URL("../ink/fixtures/demo.ink.json", import.meta.url),
  "utf8",
);
const storyHash = createHash("sha256")
  .update(compiledStoryJson.replace(/^\uFEFF/, ""))
  .digest("hex");
const LOCAL_SQLITE_TEST_TIMEOUT_MS = 15_000;
const source: StorySource = {
  load: async (version) => {
    if (
      version.id !== "quest-version-1" ||
      version.storyReference !== "stories/demo.ink.json" ||
      version.storyHash !== storyHash
    ) {
      throw new StorySourceError("NOT_FOUND", "Pinned test story was not found.");
    }

    return compiledStoryJson;
  },
};
const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "test-token",
};
const userOwner: SessionOwner = { type: "user", id: "41" };
const groupOwner: SessionOwner = { type: "group", id: "41" };
const openDatabases = new Set<LocalFileDatabase>();

class LocalFileDatabase implements TursoDatabase {
  private client: ReturnType<typeof createClient>;
  private readonly url: string;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(url: string) {
    this.url = url;
    this.client = createClient({ url, concurrency: 1, timeout: 100 });
  }

  public close(): void {
    if (this.closed) {
      return;
    }

    this.client.close();
    this.closed = true;
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
    const previousWrite = this.writeQueue;
    let releaseWrite!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    await previousWrite;

    try {
      return await this.writeTransaction(operation);
    } finally {
      releaseWrite();
    }
  }

  private async writeTransaction<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    await this.enableAndVerifyForeignKeys();

    let transaction: Transaction;
    try {
      transaction = await this.client.transaction("write");
    } catch (error) {
      this.reopenClient();
      throw error;
    }

    let reopen = false;
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
      reopen = true;
      throw error;
    } finally {
      transaction.close();
      if (reopen) {
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
    this.client = createClient({ url: this.url, concurrency: 1, timeout: 100 });
    this.closed = false;
  }
}

async function createTemporaryDatabase(): Promise<{
  directory: string;
  url: string;
  database: LocalFileDatabase;
}> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-quest-session-"));
  const url = pathToFileURL(join(directory, "quest.db")).href;
  const database = new LocalFileDatabase(url);
  openDatabases.add(database);
  return { directory, url, database };
}

async function seedQuest(database: TursoDatabase, available: boolean = true): Promise<void> {
  await database.write(async (executor) => {
    await executor.run(
      `INSERT INTO quest (id, title, description, genre, available)
       VALUES (?, ?, ?, ?, ?)`,
      "quest-1",
      "The Two Doors",
      "A compact test quest.",
      "adventure",
      available ? 1 : 0,
    );
    await executor.run(
      `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
       VALUES (?, ?, ?, ?, ?)`,
      "quest-version-1",
      "quest-1",
      "1.0.0",
      "stories/demo.ink.json",
      storyHash,
    );
  });
}

function makeService(
  database: TursoDatabase,
  options: {
    runtime?: StoryRuntime;
    source?: StorySource;
    ids?: string[];
    store?: SessionStore;
  } = {},
): SessionService {
  let nextId = 0;
  const ids = options.ids ?? [];
  return new SessionService({
    store: options.store ?? createTursoSessionStore(database),
    storyRuntime: options.runtime ?? new InkStoryRuntime(),
    storySource: options.source ?? source,
    newId: () => ids[nextId++] ?? `session-test-${nextId}`,
    now: () => 1_700_000_000_000,
  });
}

async function initializeLocalApp(
  database: TursoDatabase,
  storySource: StorySource,
): Promise<ReadyApp> {
  return initializeApp(validEnv, {
    createDatabase: () => database,
    ensureSchema,
    logFailure: () => undefined,
    storySource,
  });
}

function requireSessions(app: ReadyApp): SessionService {
  if (app.sessions === undefined) {
    throw new Error("The test application needs an explicit StorySource.");
  }

  return app.sessions;
}

async function expectSessionError(
  operation: Promise<unknown>,
  code: SessionErrorCode,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: "SessionError", code });
}

async function processedUpdateCount(database: TursoDatabase, operationId: number): Promise<number> {
  return database.read(async (executor) => {
    const row = await executor.get(
      "SELECT count(*) AS count FROM processed_update WHERE update_id = ?",
      operationId,
    );
    return Number(row?.count);
  });
}

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const database of openDatabases) {
    database.close();
  }
  openDatabases.clear();

  await Promise.all(cleanupDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("Turso session store with local libSQL", () => {
  it("persists a session and restores it through a new client without executing Ink", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const firstDatabase = temporary.database;
    const firstApp = await initializeLocalApp(firstDatabase, source);
    await seedQuest(firstDatabase);

    const firstService = requireSessions(firstApp);
    const created = await firstService.createSession(userOwner, "quest-version-1", 101);
    const started = await firstService.startSession(userOwner, created.id, 0);

    expect(started).toMatchObject({
      status: "active",
      stateVersion: 1,
      inkState: expect.any(String),
      turns: [{ stepNumber: 1, decision: null }],
    });
    const personalTimerFields = await firstDatabase.read((executor) =>
      executor.get(
        "SELECT vote_duration_ms, default_choice_index FROM turn WHERE id = ?",
        started.turns[0]?.id ?? "",
      ),
    );
    expect(personalTimerFields).toMatchObject({
      vote_duration_ms: null,
      default_choice_index: null,
    });

    const groupCreated = await firstService.createSession(groupOwner, "quest-version-1", 102);
    const groupStarted = await firstService.startSession(groupOwner, groupCreated.id, 0, {
      voteDurationMs: 60_000,
      defaultChoiceIndex: 1,
    });
    const groupTimerFields = await firstDatabase.read((executor) =>
      executor.get(
        "SELECT vote_duration_ms, default_choice_index FROM turn WHERE id = ?",
        groupStarted.turns[0]?.id ?? "",
      ),
    );
    expect(groupTimerFields).toMatchObject({
      vote_duration_ms: 60_000,
      default_choice_index: 1,
    });
    await expectSessionError(
      firstService.getSession(groupOwner, created.id),
      "FORBIDDEN_OWNER",
    );

    firstDatabase.close();
    const recoveredDatabase = new LocalFileDatabase(temporary.url);
    openDatabases.add(recoveredDatabase);
    const recoveredSource: StorySource = {
      load: vi.fn(async () => compiledStoryJson),
    };
    const recoveredApp = await initializeLocalApp(recoveredDatabase, recoveredSource);
    const recoveredService = requireSessions(recoveredApp);

    const recoveredSession = await recoveredService.getSession(userOwner, created.id);
    const turns = await recoveredService.listTurns(userOwner, created.id);

    expect(recoveredSession).toMatchObject({
      id: created.id,
      status: "active",
      stateVersion: 1,
      inkState: started.inkState,
      turns: [started.turns[0]],
    });
    expect(turns).toEqual(started.turns);
    expect(recoveredSource.load).not.toHaveBeenCalled();
    recoveredDatabase.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("isolates owners, enforces unfinished group uniqueness, and rolls back failed operation IDs", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);

    const terminalStep: StoryStep = {
      text: "A quiet ending.",
      choices: [],
      tags: ["ending:quiet"],
      stateJson: "{\"terminal\":true}",
      ended: true,
    };
    const service = makeService(database, {
      ids: ["group-session-1", "group-session-2", "group-session-3", "user-session-1"],
      runtime: {
        start: vi.fn(() => terminalStep),
        choose: vi.fn(),
      },
    });

    const firstGroupSession = await service.createSession(groupOwner, "quest-version-1", 201);
    await expectSessionError(
      service.createSession(groupOwner, "quest-version-1", 202),
      "CONFLICT",
    );
    expect(await processedUpdateCount(database, 202)).toBe(0);

    await service.startSession(groupOwner, firstGroupSession.id, 0);
    const replacementGroupSession = await service.createSession(groupOwner, "quest-version-1", 203);
    const secondGroupSession = await service.createSession(
      { type: "group", id: "-100999" },
      "quest-version-1",
      204,
    );
    const sameNumericIdUserSession = await service.createSession(userOwner, "quest-version-1", 205);
    const anotherUserSession = await service.createSession(userOwner, "quest-version-1", 206);

    expect(firstGroupSession.status).toBe("created");
    expect(replacementGroupSession.status).toBe("created");
    expect(secondGroupSession.owner).toEqual({ type: "group", id: "-100999" });
    expect(sameNumericIdUserSession.owner).toEqual(userOwner);
    expect(anotherUserSession.owner).toEqual(userOwner);
    await expectSessionError(
      service.createSession({ type: "user", id: "another-user" }, "quest-version-1", 201),
      "DUPLICATE_OPERATION",
    );

    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("stores terminal text and tags without creating an empty turn", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const terminalStep: StoryStep = {
      text: "The story has reached its ending.",
      choices: [],
      tags: ["ending:complete", "mood:hopeful"],
      stateJson: "{\"terminal\":true}",
      ended: true,
    };
    const service = makeService(database, {
      ids: ["terminal-session"],
      runtime: {
        start: vi.fn(() => terminalStep),
        choose: vi.fn(),
      },
    });
    const created = await service.createSession(userOwner, "quest-version-1", 301);

    const completed = await service.startSession(userOwner, created.id, 0);

    expect(completed).toMatchObject({
      status: "completed",
      outcome: "story_completed",
      finalScene: { text: terminalStep.text, tags: terminalStep.tags },
      turns: [],
    });
    expect(await service.listTurns(userOwner, created.id)).toEqual([]);
    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("applies both Ink branches and restores terminal output after reopening the client", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const service = makeService(database, {
      ids: [
        "left-branch-session",
        "left-branch-turn-1",
        "right-branch-session",
        "right-branch-turn-1",
        "left-branch-turn-2",
        "right-branch-turn-2",
      ],
    });

    const leftCreated = await service.createSession(userOwner, "quest-version-1", 601);
    const leftStarted = await service.startSession(userOwner, leftCreated.id, 0);
    const rightCreated = await service.createSession(
      { type: "user", id: "42" },
      "quest-version-1",
      602,
    );
    const rightStarted = await service.startSession(
      { type: "user", id: "42" },
      rightCreated.id,
      0,
    );

    const leftContinued = await service.applyDecision(
      userOwner,
      leftCreated.id,
      leftStarted.turns[0]!.id,
      0,
      leftStarted.stateVersion,
      603,
    );
    const rightContinued = await service.applyDecision(
      { type: "user", id: "42" },
      rightCreated.id,
      rightStarted.turns[0]!.id,
      1,
      rightStarted.stateVersion,
      604,
    );

    expect(leftContinued.turns[0]).toMatchObject({
      stepNumber: 2,
      sceneText: expect.stringContaining("left path"),
    });
    expect(rightContinued.turns[0]).toMatchObject({
      stepNumber: 2,
      sceneText: expect.stringContaining("right path"),
    });

    const leftCompleted = await service.applyDecision(
      userOwner,
      leftCreated.id,
      leftContinued.turns[0]!.id,
      0,
      leftContinued.stateVersion,
      605,
    );
    const rightCompleted = await service.applyDecision(
      { type: "user", id: "42" },
      rightCreated.id,
      rightContinued.turns[0]!.id,
      0,
      rightContinued.stateVersion,
      606,
    );

    expect(leftCompleted).toMatchObject({
      status: "completed",
      outcome: "story_completed",
      finalScene: { text: "The left road leads home.\n", tags: ["ending:left"] },
    });
    expect(rightCompleted).toMatchObject({
      status: "completed",
      outcome: "story_completed",
      finalScene: { text: "The right road reaches the river.\n", tags: ["ending:right"] },
    });
    database.close();

    const recoveredDatabase = new LocalFileDatabase(temporary.url);
    openDatabases.add(recoveredDatabase);
    const recoveredApp = await initializeLocalApp(recoveredDatabase, source);
    const recoveredService = requireSessions(recoveredApp);

    expect(await recoveredService.getSession(userOwner, leftCreated.id)).toMatchObject({
      status: "completed",
      stateVersion: 3,
      finalScene: { text: "The left road leads home.\n", tags: ["ending:left"] },
      turns: [],
    });
    expect(await recoveredService.listTurns(userOwner, leftCreated.id)).toMatchObject([
      { stepNumber: 1, decision: { choiceIndex: 0 } },
      { stepNumber: 2, decision: { choiceIndex: 0 } },
    ]);
    expect(await recoveredService.getSession({ type: "user", id: "42" }, rightCreated.id))
      .toMatchObject({
        status: "completed",
        finalScene: { text: "The right road reaches the river.\n", tags: ["ending:right"] },
      });
    recoveredDatabase.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("allows only one concurrent choice and detects a retried operation before Ink runs again", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const runtime = new InkStoryRuntime();
    const choose = vi.spyOn(runtime, "choose");
    const store = createTursoSessionStore(database);
    let readyCount = 0;
    let releaseBothReady!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      releaseBothReady = resolve;
    });
    const readProcessedOperation = store.hasProcessedOperation.bind(store);
    store.hasProcessedOperation = async (operationId: number): Promise<boolean> => {
      const processed = await readProcessedOperation(operationId);
      readyCount += 1;
      if (readyCount === 2) {
        releaseBothReady();
      }
      await bothReady;
      return processed;
    };
    const service = makeService(database, {
      runtime,
      store,
      ids: ["concurrent-session", "concurrent-turn", "concurrent-next-turn"],
    });
    const created = await service.createSession(userOwner, "quest-version-1", 701);
    const started = await service.startSession(userOwner, created.id, 0);
    const turnId = started.turns[0]!.id;

    const results = await Promise.allSettled([
      service.applyDecision(userOwner, created.id, turnId, 0, started.stateVersion, 702),
      service.applyDecision(userOwner, created.id, turnId, 1, started.stateVersion, 703),
    ]);
    const fulfilledIndex = results.findIndex((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    expect(fulfilledIndex).not.toBe(-1);
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ name: "SessionError", code: "CONFLICT" });
    }

    const winningOperationId = fulfilledIndex === 0 ? 702 : 703;
    const afterRace = await service.getSession(userOwner, created.id);
    expect(afterRace).toMatchObject({ status: "active", stateVersion: 2 });
    expect(await processedUpdateCount(database, 702) + await processedUpdateCount(database, 703))
      .toBe(1);
    const callsBeforeRetry = choose.mock.calls.length;

    await expectSessionError(
      service.applyDecision(userOwner, created.id, turnId, 0, started.stateVersion, winningOperationId),
      "DUPLICATE_OPERATION",
    );

    expect(choose).toHaveBeenCalledTimes(callsBeforeRetry);
    expect((await service.listTurns(userOwner, created.id))).toHaveLength(2);
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("rolls back the processed operation and session update when inserting the next turn fails", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const service = makeService(database, {
      ids: ["rollback-session", "rollback-turn", "rollback-turn"],
    });
    const created = await service.createSession(userOwner, "quest-version-1", 801);
    const started = await service.startSession(userOwner, created.id, 0);

    await expectSessionError(
      service.applyDecision(
        userOwner,
        created.id,
        started.turns[0]!.id,
        0,
        started.stateVersion,
        802,
      ),
      "STORAGE_FAILURE",
    );

    expect(await processedUpdateCount(database, 802)).toBe(0);
    expect(await service.getSession(userOwner, created.id)).toMatchObject({
      status: "active",
      stateVersion: 1,
      inkState: started.inkState,
      turns: [{ id: started.turns[0]!.id, decision: null }],
    });
    expect(await service.listTurns(userOwner, created.id)).toHaveLength(1);
    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("rolls back session activation when the initial turn insert fails", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const firstService = makeService(database, {
      ids: ["first-session", "shared-turn-id"],
    });
    const firstSession = await firstService.createSession(userOwner, "quest-version-1", 350);
    await firstService.startSession(userOwner, firstSession.id, 0);

    const secondService = makeService(database, {
      ids: ["second-session", "shared-turn-id"],
    });
    const secondSession = await secondService.createSession(userOwner, "quest-version-1", 351);

    await expectSessionError(
      secondService.startSession(userOwner, secondSession.id, 0),
      "STORAGE_FAILURE",
    );

    const unchanged = await secondService.getSession(userOwner, secondSession.id);
    expect(unchanged).toMatchObject({
      status: "created",
      stateVersion: 0,
      inkState: null,
      turns: [],
    });
    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("does not activate a session when its pinned version hash changes during story loading", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const changedHash = storyHash === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    const changingSource: StorySource = {
      load: async () => {
        await database.write((executor) => executor.run(
          "UPDATE quest_version SET story_hash = ? WHERE id = ?",
          changedHash,
          "quest-version-1",
        ));
        return compiledStoryJson;
      },
    };
    const service = makeService(database, {
      ids: ["version-race-session"],
      source: changingSource,
    });
    const created = await service.createSession(userOwner, "quest-version-1", 401);

    await expectSessionError(
      service.startSession(userOwner, created.id, 0),
      "STORY_MISMATCH",
    );

    const unchanged = await service.getSession(userOwner, created.id);
    expect(unchanged).toMatchObject({
      status: "created",
      stateVersion: 0,
      inkState: null,
      turns: [],
    });
    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("does not activate a session if its quest becomes unavailable while loading", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const changingSource: StorySource = {
      load: async () => {
        await database.write((executor) => executor.run(
          "UPDATE quest SET available = 0 WHERE id = ?",
          "quest-1",
        ));
        return compiledStoryJson;
      },
    };
    const service = makeService(database, {
      ids: ["availability-race-session"],
      source: changingSource,
    });
    const created = await service.createSession(userOwner, "quest-version-1", 402);

    await expectSessionError(
      service.startSession(userOwner, created.id, 0),
      "INVALID_TRANSITION",
    );

    expect(await service.getSession(userOwner, created.id)).toMatchObject({
      status: "created",
      stateVersion: 0,
      inkState: null,
      turns: [],
    });
    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);
});
