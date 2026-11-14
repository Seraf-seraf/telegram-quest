import { describe, expect, it, vi } from "vitest";
import {
  createReadyAppGetter,
  initializeApp,
  type BootstrapDependencies,
} from "./bootstrap.js";
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
    logFailure: () => undefined,
    ...overrides,
  };
}

const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "turso-auth-token",
};

describe("initializeApp", () => {
  it("validates storage config, migrates schema, then builds the runtime", async () => {
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
    }));

    expect(calls).toEqual([
      "connect:libsql://quest-example.turso.io",
      "schema:true",
    ]);
    expect(result.database).toBe(database);
    expect(result.storyRuntime).toBeDefined();
    expect(database.closed).toBe(false);
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
