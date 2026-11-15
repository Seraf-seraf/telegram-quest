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
import { assetReferences } from "../../app/content.js";

const compiledStoryJson = readFileSync(
  new URL("../ink/fixtures/demo.ink.json", import.meta.url),
  "utf8",
);
const LOCAL_SQLITE_TEST_TIMEOUT_MS = 30_000;
const source: StorySource = {
  load: async (questId) => {
    if (questId !== "quest-1") {
      throw new StorySourceError("NOT_FOUND", "Test quest story was not found.");
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
      `INSERT INTO quest (id, title, description, genre, available, story_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "quest-1",
      "The Two Doors",
      "A compact test quest.",
      "adventure",
      available ? 1 : 0,
      compiledStoryJson.replace(/^\uFEFF/, ""),
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
    now?: () => number;
  } = {},
): SessionService {
  let nextId = 0;
  const ids = options.ids ?? [];
  return new SessionService({
    store: options.store ?? createTursoSessionStore(database),
    storyRuntime: options.runtime ?? new InkStoryRuntime(),
    storySource: options.source ?? source,
    newId: () => ids[nextId++] ?? `session-test-${nextId}`,
    now: options.now ?? (() => 1_700_000_000_000),
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

async function addTestVote(
  database: TursoDatabase,
  turnId: string,
  voterId: string,
): Promise<void> {
  await database.write((executor) => executor.run(
    `INSERT INTO vote (turn_id, voter_id, choice_index, cast_at_ms)
     VALUES (?, ?, ?, ?)`,
    turnId,
    voterId,
    0,
    1_700_000_000_000,
  ));
}

async function readTurnTimer(database: TursoDatabase, turnId: string): Promise<SqlRow | undefined> {
  return database.read((executor) => executor.get(
    `SELECT default_choice_index, vote_duration_ms, deadline_at_ms, remaining_ms,
            interactive_message_id
       FROM turn
      WHERE id = ?`,
    turnId,
  ));
}

async function countVotes(database: TursoDatabase, turnId: string): Promise<number> {
  return database.read(async (executor) => {
    const row = await executor.get("SELECT count(*) AS count FROM vote WHERE turn_id = ?", turnId);
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
  it("lists bounded owner-only session summaries in deterministic pages", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);

    const service = makeService(database, {
      ids: ["session-a", "session-b", "session-c", "session-d", "session-e"],
    });
    await service.createSession(userOwner, "quest-1", 701);
    await service.createSession(userOwner, "quest-1", 702);
    await service.createSession(userOwner, "quest-1", 703);
    await service.createSession(groupOwner, "quest-1", 704);
    await service.createSession({ type: "user", id: "42" }, "quest-1", 705);

    const store = createTursoSessionStore(database);
    const firstPage = await store.listOwnedSessions(userOwner, 2, null);
    expect(firstPage.sessions).toEqual([
      {
        id: "session-a",
        questId: "quest-1",
        questTitle: "The Two Doors",
        status: "created",
        stateVersion: 0,
      },
      {
        id: "session-b",
        questId: "quest-1",
        questTitle: "The Two Doors",
        status: "created",
        stateVersion: 0,
      },
    ]);
    expect(firstPage.nextCursor).toBe("session-b");

    const secondPage = await store.listOwnedSessions(userOwner, 2, firstPage.nextCursor);
    expect(secondPage.sessions.map((session) => session.id)).toEqual(["session-c"]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.sessions[0]).not.toHaveProperty("turns");
    expect(await store.listOwnedSessions(groupOwner, 2, null)).toMatchObject({
      sessions: [{ id: "session-d", status: "created" }],
      nextCursor: null,
    });
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("persists a session and restores it through a new client without executing Ink", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const firstDatabase = temporary.database;
    const firstApp = await initializeLocalApp(firstDatabase, source);
    await seedQuest(firstDatabase);

    const firstService = requireSessions(firstApp);
    const created = await firstService.createSession(userOwner, "quest-1", 101);
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

    const groupCreated = await firstService.createSession(groupOwner, "quest-1", 102);
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

  it("persists scene references through choice, rewind, restart, recovery, and fresh metadata reads", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const runtime: StoryRuntime = {
      start: () => ({
        text: "The corridor begins.",
        choices: [{ index: 0, text: "Continue", tags: [] }],
        tags: ["asset:dark_corridor"],
        stateJson: JSON.stringify({ step: 1 }),
        ended: false,
      }),
      choose: () => ({
        text: "A note appears.",
        choices: [{ index: 0, text: "Continue", tags: [] }],
        tags: ["asset:corridor_note"],
        stateJson: JSON.stringify({ step: 2 }),
        ended: false,
      }),
    };
    const service = makeService(database, {
      runtime,
      ids: [
        "metadata-session",
        "metadata-turn-start",
        "metadata-turn-choice",
        "metadata-turn-rewind",
        "metadata-turn-restart",
      ],
    });
    const created = await service.createSession(userOwner, "quest-1", 1_501);
    const started = await service.startSession(userOwner, created.id, 0);
    expect(started.turns[0]?.sceneTags).toEqual(["asset:dark_corridor"]);

    const afterChoice = await service.applyDecision(
      userOwner,
      created.id,
      started.turns[0]!.id,
      0,
      started.stateVersion,
      1_502,
    );
    expect((await service.listTurns(userOwner, created.id)).map((turn) => turn.sceneTags))
      .toEqual([["asset:dark_corridor"], ["asset:corridor_note"]]);

    const rewound = await service.rewindSession(
      userOwner,
      created.id,
      1,
      afterChoice.stateVersion,
    );
    expect(rewound.turns[0]?.sceneTags).toEqual(["asset:dark_corridor"]);

    const restarted = await service.restartSession(userOwner, created.id, rewound.stateVersion, true);
    expect(restarted.turns[0]?.sceneTags).toEqual(["asset:dark_corridor"]);
    expect(JSON.stringify(restarted.turns[0]?.sceneTags)).not.toContain("https://");

    await database.write((executor) => executor.run(
      `INSERT INTO content_metadata (quest_id, name, kind, value) VALUES (?, ?, 'image', ?)`,
      "quest-1",
      "dark_corridor",
      "https://cdn.example/first.jpg",
    ));
    database.close();

    const recoveredDatabase = new LocalFileDatabase(temporary.url);
    openDatabases.add(recoveredDatabase);
    const recoveredApp = await initializeLocalApp(recoveredDatabase, source);
    const recoveredService = requireSessions(recoveredApp);
    const recovered = await recoveredService.getSession(userOwner, created.id);
    const recoveredTurn = recovered.turns[0]!;
    expect(recoveredTurn.sceneTags).toEqual(["asset:dark_corridor"]);

    const firstResolution = await recoveredApp.resolveContent(
      recovered.questId,
      recoveredTurn.sceneText,
      assetReferences(recoveredTurn.sceneTags),
    );
    expect(firstResolution.imageUrl).toBe("https://cdn.example/first.jpg");

    await recoveredDatabase.write((executor) => executor.run(
      "UPDATE content_metadata SET value = ? WHERE quest_id = ? AND name = ?",
      "https://cdn.example/updated.jpg",
      "quest-1",
      "dark_corridor",
    ));
    const nextReadSession = await recoveredService.getSession(userOwner, created.id);
    const nextResolution = await recoveredApp.resolveContent(
      nextReadSession.questId,
      nextReadSession.turns[0]!.sceneText,
      assetReferences(nextReadSession.turns[0]!.sceneTags),
    );
    expect(nextReadSession.stateVersion).toBe(recovered.stateVersion);
    expect(nextReadSession.turns[0]?.choices).toEqual(recoveredTurn.choices);
    expect(nextResolution.imageUrl).toBe("https://cdn.example/updated.jpg");
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

    const firstGroupSession = await service.createSession(groupOwner, "quest-1", 201);
    await expectSessionError(
      service.createSession(groupOwner, "quest-1", 202),
      "CONFLICT",
    );
    expect(await processedUpdateCount(database, 202)).toBe(0);

    await service.startSession(groupOwner, firstGroupSession.id, 0);
    const replacementGroupSession = await service.createSession(groupOwner, "quest-1", 203);
    const secondGroupSession = await service.createSession(
      { type: "group", id: "-100999" },
      "quest-1",
      204,
    );
    const sameNumericIdUserSession = await service.createSession(userOwner, "quest-1", 205);
    const anotherUserSession = await service.createSession(userOwner, "quest-1", 206);

    expect(firstGroupSession.status).toBe("created");
    expect(replacementGroupSession.status).toBe("created");
    expect(secondGroupSession.owner).toEqual({ type: "group", id: "-100999" });
    expect(sameNumericIdUserSession.owner).toEqual(userOwner);
    expect(anotherUserSession.owner).toEqual(userOwner);
    await expectSessionError(
      service.createSession({ type: "user", id: "another-user" }, "quest-1", 201),
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
    const created = await service.createSession(userOwner, "quest-1", 301);

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

    const leftCreated = await service.createSession(userOwner, "quest-1", 601);
    const leftStarted = await service.startSession(userOwner, leftCreated.id, 0);
    const rightCreated = await service.createSession(
      { type: "user", id: "42" },
      "quest-1",
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
    const created = await service.createSession(userOwner, "quest-1", 701);
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
    const created = await service.createSession(userOwner, "quest-1", 801);
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

  it("preserves started and unstarted group timers across pause, restart, and independent chats", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const firstGroup: SessionOwner = { type: "group", id: "-100-paused" };
    const secondGroup: SessionOwner = { type: "group", id: "-100-untimed" };
    const firstService = makeService(database, {
      ids: ["paused-session", "paused-turn", "untimed-session", "untimed-turn"],
      now: () => 1_500,
    });
    const timedCreated = await firstService.createSession(firstGroup, "quest-1", 901);
    const timedStarted = await firstService.startSession(firstGroup, timedCreated.id, 0, {
      voteDurationMs: 60_000,
      defaultChoiceIndex: 0,
    });
    const timedTurnId = timedStarted.turns[0]!.id;
    expect(await readTurnTimer(database, timedTurnId)).toMatchObject({
      deadline_at_ms: null,
      remaining_ms: null,
    });
    await database.write((executor) => executor.run(
      `UPDATE turn SET deadline_at_ms = ?, interactive_message_id = ? WHERE id = ?`,
      2_000,
      77,
      timedTurnId,
    ));

    const paused = await firstService.pauseSession(firstGroup, timedCreated.id, 1);
    expect(paused).toMatchObject({ status: "paused", stateVersion: 2 });
    expect(await readTurnTimer(database, timedTurnId)).toMatchObject({
      vote_duration_ms: 60_000,
      deadline_at_ms: null,
      remaining_ms: 500,
      interactive_message_id: 77,
    });
    await expectSessionError(
      firstService.applyDecision(firstGroup, timedCreated.id, timedTurnId, 0, 2, 902, {
        voteDurationMs: 60_000,
        defaultChoiceIndex: 0,
      }),
      "INVALID_TRANSITION",
    );

    const untimedCreated = await firstService.createSession(secondGroup, "quest-1", 903);
    const untimedStarted = await firstService.startSession(secondGroup, untimedCreated.id, 0, {
      voteDurationMs: 60_000,
      defaultChoiceIndex: 1,
    });
    expect(await readTurnTimer(database, untimedStarted.turns[0]!.id)).toMatchObject({
      deadline_at_ms: null,
      remaining_ms: null,
    });
    database.close();

    const recoveredDatabase = new LocalFileDatabase(temporary.url);
    openDatabases.add(recoveredDatabase);
    const resumeService = makeService(recoveredDatabase, { now: () => 10_000 });
    expect(await resumeService.getSession(firstGroup, timedCreated.id)).toMatchObject({
      status: "paused",
      stateVersion: 2,
      inkState: timedStarted.inkState,
    });
    const resumed = await resumeService.resumeSession(firstGroup, timedCreated.id, 2);
    expect(resumed).toMatchObject({ status: "active", stateVersion: 3 });
    expect(await readTurnTimer(recoveredDatabase, timedTurnId)).toMatchObject({
      deadline_at_ms: 10_500,
      remaining_ms: null,
    });

    const untimedPaused = await resumeService.pauseSession(secondGroup, untimedCreated.id, 1);
    const untimedResumeService = makeService(recoveredDatabase, { now: () => 20_000 });
    const untimedResumed = await untimedResumeService.resumeSession(
      secondGroup,
      untimedCreated.id,
      untimedPaused.stateVersion,
    );
    expect(untimedResumed).toMatchObject({ status: "active", stateVersion: 3 });
    expect(await readTurnTimer(recoveredDatabase, untimedStarted.turns[0]!.id)).toMatchObject({
      deadline_at_ms: null,
      remaining_ms: null,
    });

    const stopped = await untimedResumeService.stopSession(firstGroup, timedCreated.id, 3);
    expect(stopped).toMatchObject({
      status: "completed",
      stateVersion: 4,
      outcome: "stopped_by_owner",
      finalScene: null,
      turns: [],
    });
    expect(await readTurnTimer(recoveredDatabase, timedTurnId)).toMatchObject({
      deadline_at_ms: null,
      remaining_ms: null,
    });
    expect(await resumeService.getSession(secondGroup, untimedCreated.id)).toMatchObject({
      status: "active",
      stateVersion: 3,
    });
    recoveredDatabase.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("stops a created session and restarts a confirmed run after clearing turns and votes", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const group: SessionOwner = { type: "group", id: "-100-restart" };
    const service = makeService(database, {
      ids: [
        "created-stop-session",
        "restart-session",
        "old-turn-1",
        "fresh-turn-1",
        "fresh-turn-2",
      ],
    });
    const created = await service.createSession(userOwner, "quest-1", 1_001);
    const stoppedCreated = await service.stopSession(userOwner, created.id, 0);
    expect(stoppedCreated).toMatchObject({
      status: "completed",
      stateVersion: 1,
      outcome: "stopped_by_owner",
      inkState: null,
      turns: [],
    });

    const restartCreated = await service.createSession(group, "quest-1", 1_002);
    const started = await service.startSession(group, restartCreated.id, 0, {
      voteDurationMs: 30_000,
      defaultChoiceIndex: 0,
    });
    const oldTurnId = started.turns[0]!.id;
    await database.write((executor) => executor.run(
      `UPDATE turn SET deadline_at_ms = ?, interactive_message_id = ? WHERE id = ?`,
      1_800_000_000_000,
      88,
      oldTurnId,
    ));
    await addTestVote(database, oldTurnId, "voter-before-restart");

    const restarted = await service.restartSession(group, restartCreated.id, 1, true, {
      voteDurationMs: 30_000,
      defaultChoiceIndex: 1,
    });
    const newTurnId = restarted.turns[0]!.id;
    expect(restarted).toMatchObject({
      id: restartCreated.id,
      questId: "quest-1",
      status: "active",
      stateVersion: 2,
      turns: [{ stepNumber: 1, decision: null }],
    });
    expect(newTurnId).not.toBe(oldTurnId);
    expect(await service.listTurns(group, restartCreated.id)).toHaveLength(1);
    expect(await countVotes(database, oldTurnId)).toBe(0);
    expect(await readTurnTimer(database, newTurnId)).toMatchObject({
      default_choice_index: 1,
      vote_duration_ms: 30_000,
      deadline_at_ms: null,
      remaining_ms: null,
      interactive_message_id: null,
    });

    await expectSessionError(
      service.applyDecision(group, restartCreated.id, oldTurnId, 0, restarted.stateVersion, 1_003, {
        voteDurationMs: 30_000,
        defaultChoiceIndex: 1,
      }),
      "INVALID_TRANSITION",
    );
    const next = await service.applyDecision(group, restartCreated.id, newTurnId, 0, 2, 1_004, {
      voteDurationMs: 30_000,
      defaultChoiceIndex: 1,
    });
    const completed = await service.applyDecision(
      group,
      restartCreated.id,
      next.turns[0]!.id,
      0,
      next.stateVersion,
      1_005,
      { voteDurationMs: 30_000, defaultChoiceIndex: 1 },
    );
    expect(completed).toMatchObject({ status: "completed", outcome: "story_completed" });
    await expectSessionError(
      service.rewindSession(group, restartCreated.id, 1, completed.stateVersion),
      "INVALID_TRANSITION",
    );
    database.close();
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it("rewinds active and paused group history irreversibly and cascades votes", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const group: SessionOwner = { type: "group", id: "-100-rewind" };
    const service = makeService(database, {
      ids: [
        "rewind-session",
        "old-turn-1",
        "old-turn-2",
        "replacement-turn-1",
        "replacement-turn-2",
      ],
    });
    const created = await service.createSession(group, "quest-1", 1_101);
    const started = await service.startSession(group, created.id, 0, {
      voteDurationMs: 60_000,
      defaultChoiceIndex: 1,
    });
    const oldTurn1 = started.turns[0]!;
    await database.write((executor) => executor.run(
      `UPDATE turn SET deadline_at_ms = ?, interactive_message_id = ? WHERE id = ?`,
      1_800_000_000_000,
      91,
      oldTurn1.id,
    ));
    await addTestVote(database, oldTurn1.id, "rewind-voter-1");
    const afterFirstChoice = await service.applyDecision(
      group,
      created.id,
      oldTurn1.id,
      0,
      started.stateVersion,
      1_102,
      { voteDurationMs: 60_000, defaultChoiceIndex: 1 },
    );
    const oldTurn2 = afterFirstChoice.turns[0]!;
    await database.write((executor) => executor.run(
      `UPDATE turn SET deadline_at_ms = ?, interactive_message_id = ? WHERE id = ?`,
      1_800_000_000_100,
      92,
      oldTurn2.id,
    ));
    await addTestVote(database, oldTurn2.id, "rewind-voter-2");

    const rewound = await service.rewindSession(
      group,
      created.id,
      1,
      afterFirstChoice.stateVersion,
    );
    const replacementTurn1 = rewound.turns[0]!;
    expect(rewound).toMatchObject({
      status: "active",
      stateVersion: 3,
      inkState: oldTurn1.inkCheckpoint,
      turns: [{ stepNumber: 1, sceneText: oldTurn1.sceneText, choices: oldTurn1.choices, decision: null }],
    });
    expect(replacementTurn1.id).not.toBe(oldTurn1.id);
    expect(await service.listTurns(group, created.id)).toHaveLength(1);
    expect(await countVotes(database, oldTurn1.id)).toBe(0);
    expect(await countVotes(database, oldTurn2.id)).toBe(0);
    expect(await readTurnTimer(database, replacementTurn1.id)).toMatchObject({
      default_choice_index: 1,
      vote_duration_ms: 60_000,
      deadline_at_ms: null,
      remaining_ms: null,
      interactive_message_id: null,
    });
    await expectSessionError(
      service.applyDecision(group, created.id, oldTurn1.id, 0, 3, 1_103, {
        voteDurationMs: 60_000,
        defaultChoiceIndex: 1,
      }),
      "INVALID_TRANSITION",
    );

    await addTestVote(database, replacementTurn1.id, "kept-voter");
    const newStep2 = await service.applyDecision(
      group,
      created.id,
      replacementTurn1.id,
      1,
      rewound.stateVersion,
      1_104,
      { voteDurationMs: 60_000, defaultChoiceIndex: 1 },
    );
    const paused = await service.pauseSession(group, created.id, newStep2.stateVersion);
    const oldCurrentTurn2Id = newStep2.turns[0]!.id;
    await database.write((executor) => executor.run(
      `UPDATE turn SET deadline_at_ms = ?, interactive_message_id = ? WHERE id = ?`,
      1_800_000_000_200,
      93,
      oldCurrentTurn2Id,
    ));
    await addTestVote(database, oldCurrentTurn2Id, "paused-rewind-voter");
    const pausedRewind = await service.rewindSession(group, created.id, 2, paused.stateVersion);

    expect(pausedRewind).toMatchObject({
      status: "paused",
      stateVersion: paused.stateVersion + 1,
      turns: [{ stepNumber: 2, decision: null }],
    });
    expect(pausedRewind.turns[0]?.id).not.toBe(oldCurrentTurn2Id);
    expect(await countVotes(database, replacementTurn1.id)).toBe(1);
    expect(await countVotes(database, oldCurrentTurn2Id)).toBe(0);
    expect(await service.listTurns(group, created.id)).toMatchObject([
      { stepNumber: 1, decision: { choiceIndex: 1 } },
      { stepNumber: 2, decision: null },
    ]);
    expect(await readTurnTimer(database, pausedRewind.turns[0]!.id)).toMatchObject({
      deadline_at_ms: null,
      remaining_ms: null,
      interactive_message_id: null,
    });

    const resumed = await service.resumeSession(group, created.id, pausedRewind.stateVersion);
    await expectSessionError(
      service.applyDecision(group, created.id, oldCurrentTurn2Id, 0, resumed.stateVersion, 1_105, {
        voteDurationMs: 60_000,
        defaultChoiceIndex: 1,
      }),
      "INVALID_TRANSITION",
    );
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
    const firstSession = await firstService.createSession(userOwner, "quest-1", 350);
    await firstService.startSession(userOwner, firstSession.id, 0);

    const secondService = makeService(database, {
      ids: ["second-session", "shared-turn-id"],
    });
    const secondSession = await secondService.createSession(userOwner, "quest-1", 351);

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

  it("loads the current story by quest ID without checking a story fingerprint", async () => {
    const temporary = await createTemporaryDatabase();
    cleanupDirectories.push(temporary.directory);
    const database = temporary.database;
    await ensureSchema(database);
    await seedQuest(database);
    const load = vi.fn(async (questId: string): Promise<string> => {
      expect(questId).toBe("quest-1");
      return compiledStoryJson;
    });
    const changingSource: StorySource = {
      load,
    };
    const service = makeService(database, {
      ids: ["current-story-session", "current-story-turn"],
      source: changingSource,
    });
    const created = await service.createSession(userOwner, "quest-1", 401);

    const started = await service.startSession(userOwner, created.id, 0);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("quest-1");
    expect(started).toMatchObject({ id: created.id, status: "active", stateVersion: 1 });
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
    const created = await service.createSession(userOwner, "quest-1", 402);

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
