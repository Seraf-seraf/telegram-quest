import { describe, expect, it, vi } from "vitest";
import {
  createReadyAppGetter,
  initializeApp,
  type BootstrapDependencies,
} from "./bootstrap.js";
import { SessionService } from "./app/sessions.js";
import type { StorySource } from "./app/story-source.js";
import type { TursoDatabase } from "./adapters/turso/client.js";

function createFakeDatabase(): TursoDatabase & { closed: boolean } {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
    async read() {
      throw new Error("Unexpected read.");
    },
    async write() {
      throw new Error("Unexpected write.");
    },
  };
}

function dependencies(
  database: TursoDatabase,
  overrides: Partial<BootstrapDependencies> = {},
): BootstrapDependencies {
  return {
    createDatabase: () => database,
    ensureSchema: async () => undefined,
    ensureDemoCatalog: async () => undefined,
    logFailure: () => undefined,
    ...overrides,
  };
}

const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "turso-auth-token",
};

describe("initializeApp", () => {
  it("validates config, ensures schema and catalog, then builds ready services", async () => {
    const database = createFakeDatabase();
    const calls: string[] = [];
    const result = await initializeApp(validEnv, dependencies(database, {
      createDatabase: (config) => {
        calls.push(`connect:${config.databaseUrl}`);
        return database;
      },
      ensureSchema: async (receivedDatabase) => {
        calls.push(`schema:${receivedDatabase === database}`);
      },
      ensureDemoCatalog: async (receivedDatabase, storySource) => {
        calls.push(`catalog:${receivedDatabase === database}:${typeof storySource.load}`);
      },
    }));

    expect(calls).toEqual([
      "connect:libsql://quest-example.turso.io",
      "schema:true",
      "catalog:true:function",
    ]);
    expect(result.database).toBe(database);
    expect(result.storyRuntime).toBeDefined();
    expect(result.sessions).toBeInstanceOf(SessionService);
    expect(result.catalog.listAvailableQuests).toBeTypeOf("function");
    expect(database.closed).toBe(false);
  });

  it("uses an injected story source for tests without changing the ready app contract", async () => {
    const database = createFakeDatabase();
    const storySource: StorySource = {
      load: async () => "compiled-story-fixture",
    };

    const result = await initializeApp(validEnv, dependencies(database, { storySource }));

    expect(result.sessions).toBeInstanceOf(SessionService);
    expect(result.sessions.getSession).toBeTypeOf("function");
    expect(result.catalog.listVersions).toBeTypeOf("function");
    expect(result.storyRuntime).toBeDefined();
  });

  it("does not create a database for invalid config and logs no secret", async () => {
    const database = createFakeDatabase();
    const createDatabase = vi.fn(() => database);
    const logFailure = vi.fn();

    await expect(initializeApp({
      ...validEnv,
      TURSO_AUTH_TOKEN: "sensitive-token",
      TURSO_DATABASE_URL: "file:private.db",
    }, dependencies(database, { createDatabase, logFailure }))).rejects.toThrow(
      "Application initialization failed.",
    );

    expect(createDatabase).not.toHaveBeenCalled();
    expect(database.closed).toBe(false);
    expect(logFailure).toHaveBeenCalledWith({
      event: "telegram_quest.bootstrap_failed",
      phase: "configuration",
      code: "APP_INITIALIZATION_FAILED",
    });
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain("sensitive-token");
  });

  it("closes storage and emits a safe event when schema initialization fails", async () => {
    const database = createFakeDatabase();
    const logFailure = vi.fn();

    await expect(initializeApp(validEnv, dependencies(database, {
      ensureSchema: async () => {
        throw new Error("database URL and auth token must stay private");
      },
      logFailure,
    }))).rejects.toThrow("Application initialization failed.");

    expect(database.closed).toBe(true);
    expect(logFailure).toHaveBeenCalledWith({
      event: "telegram_quest.bootstrap_failed",
      phase: "schema",
      code: "APP_INITIALIZATION_FAILED",
    });
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain("auth token");
  });

  it("closes storage and emits a safe event when demo catalog initialization fails", async () => {
    const database = createFakeDatabase();
    const logFailure = vi.fn();

    await expect(initializeApp(validEnv, dependencies(database, {
      ensureDemoCatalog: async () => {
        throw new Error("database URL and token must stay private");
      },
      logFailure,
    }))).rejects.toThrow("Application initialization failed.");

    expect(database.closed).toBe(true);
    expect(logFailure).toHaveBeenCalledWith({
      event: "telegram_quest.bootstrap_failed",
      phase: "catalog",
      code: "APP_INITIALIZATION_FAILED",
    });
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain("token");
  });
});

describe("createReadyAppGetter", () => {
  it("shares concurrent successful initialization", async () => {
    const app = { ready: true };
    const factory = vi.fn(async () => app);
    const getReady = createReadyAppGetter(factory);

    const [first, second] = await Promise.all([getReady(), getReady()]);

    expect(first).toBe(app);
    expect(second).toBe(app);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("clears a failed initialization so the next request can retry", async () => {
    const app = { ready: true };
    const factory = vi.fn<() => Promise<typeof app>>()
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockResolvedValueOnce(app);
    const getReady = createReadyAppGetter(factory);

    await expect(getReady()).rejects.toThrow("initial failure");
    await expect(getReady()).resolves.toBe(app);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
