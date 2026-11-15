import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileInkStory } from "../internal/adapters/ink/compiler.js";
import type { SqlExecutor, TursoDatabase } from "../internal/adapters/turso/client.js";
import type { QuestPublicationPort } from "../internal/app/publish-quest.js";
import {
  assertPublicationSchemaReady,
  parseCliArguments,
  runPublishQuestCli,
} from "./publish-quest.js";

const temporaryDirectories = new Set<string>();

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-quest-cli-"));
  temporaryDirectories.add(directory);
  return directory;
}

function createFakeDatabase(): TursoDatabase {
  const executor = {
    all: async () => [],
    exec: async () => {},
    get: async () => undefined,
    run: async () => {},
  };
  return {
    close: vi.fn(),
    read: async <T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> =>
      operation(executor),
    write: async <T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> =>
      operation(executor),
  };
}

function createFakePublisher(): QuestPublicationPort {
  return {
    publishQuest: vi.fn(async () => {}),
    updateQuestMetadata: vi.fn(async () => {}),
    publishMenu: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
  temporaryDirectories.clear();
});

describe("publish quest CLI", () => {
  it("parses full, metadata-only, menu, and dry-run modes", () => {
    expect(parseCliArguments(["book"])).toEqual({
      mode: "full",
      inputPath: "book",
      dryRun: false,
    });
    expect(parseCliArguments(["book", "--metadata-only", "--dry-run"])).toEqual({
      mode: "metadata-only",
      inputPath: "book",
      dryRun: true,
    });
    expect(parseCliArguments(["--menu", "menu.json", "--dry-run"])).toEqual({
      mode: "menu",
      inputPath: "menu.json",
      dryRun: true,
    });
    expect(() => parseCliArguments(["book", "--metadata-only", "--metadata-only"]))
      .toThrow("Usage:");
  });

  it("executes a real compiled CLI dry-run without environment or database access", async () => {
    const directory = await createTempDirectory();
    await writeFile(join(directory, "quest.json"), JSON.stringify({
      id: "temporary-book",
      title: "Temporary book",
      description: "For dry run",
      genre: "Test",
      available: true,
    }), "utf8");
    await writeFile(join(directory, "story.ink"), [
      "-> start",
      "=== start",
      "A door waits.",
      "+ [Continue]",
      "    -> END",
    ].join("\n"), "utf8");

    const output = vi.fn();
    const database = createFakeDatabase();
    await runPublishQuestCli([directory, "--dry-run"], {
      readFile: async (filePath, encoding) =>
        (await import("node:fs/promises")).readFile(filePath, encoding),
      compileStory: compileInkStory,
      loadStorageConfig: () => {
        throw new Error("Dry run must not load database credentials.");
      },
      createDatabase: () => {
        throw new Error("Dry run must not open a database.");
      },
      assertSchemaReady: async () => {},
      createPublisher: () => createFakePublisher(),
      writeOutput: output,
      writeError: vi.fn(),
    }, {});

    expect(output).toHaveBeenCalledWith("Dry run passed. No database connection was made.");
    expect(database.close).not.toHaveBeenCalled();
  });

  it("runs metadata-only without reading or compiling story.ink", async () => {
    const directory = await createTempDirectory();
    const manifestPath = join(directory, "quest.json");
    await writeFile(manifestPath, JSON.stringify({
      id: "temporary-book",
      title: "Temporary book",
      description: "Metadata update",
      genre: "Test",
      available: false,
      metadata: { cover: null },
    }), "utf8");
    const database = createFakeDatabase();
    const publisher = createFakePublisher();
    const readPaths: string[] = [];
    const compileStory = vi.fn(async () => {
      throw new Error("metadata-only must not compile the story");
    });

    await runPublishQuestCli([directory, "--metadata-only"], {
      readFile: async (filePath, encoding) => {
        readPaths.push(filePath);
        return (await import("node:fs/promises")).readFile(filePath, encoding);
      },
      compileStory,
      loadStorageConfig: () => ({
        databaseUrl: "libsql://test.invalid",
        authToken: "test-token",
      }),
      createDatabase: () => database,
      assertSchemaReady: async () => {},
      createPublisher: () => publisher,
      writeOutput: vi.fn(),
      writeError: vi.fn(),
    }, {});

    expect(readPaths).toEqual([manifestPath]);
    expect(compileStory).not.toHaveBeenCalled();
    expect(publisher.updateQuestMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: "temporary-book" }),
      [{ name: "cover", value: null }],
    );
    expect(publisher.publishQuest).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("routes --menu only to the global metadata publisher", async () => {
    const directory = await createTempDirectory();
    const menuPath = join(directory, "menu.json");
    await writeFile(menuPath, JSON.stringify({
      metadata: { "menu.main.banner": { kind: "image", value: "https://assets.example/menu.jpg" } },
    }), "utf8");
    const publisher = createFakePublisher();
    const database = createFakeDatabase();

    await runPublishQuestCli(["--menu", menuPath], {
      readFile: async (filePath, encoding) =>
        (await import("node:fs/promises")).readFile(filePath, encoding),
      compileStory: vi.fn(),
      loadStorageConfig: () => ({
        databaseUrl: "libsql://test.invalid",
        authToken: "test-token",
      }),
      createDatabase: () => database,
      assertSchemaReady: async () => {},
      createPublisher: () => publisher,
      writeOutput: vi.fn(),
      writeError: vi.fn(),
    }, {});

    expect(publisher.publishMenu).toHaveBeenCalledWith([{
      name: "menu.main.banner",
      value: { kind: "image", value: "https://assets.example/menu.jpg" },
    }]);
    expect(publisher.publishQuest).not.toHaveBeenCalled();
    expect(publisher.updateQuestMetadata).not.toHaveBeenCalled();
  });

  it("checks schema v4 using reads only", async () => {
    const queries: string[] = [];
    let writeCalls = 0;
    const database: TursoDatabase = {
      close: vi.fn(),
      read: async (operation) => operation({
        all: async (sql) => {
          queries.push(sql);
          return [];
        },
        exec: async (sql) => {
          queries.push(sql);
        },
        get: async (sql) => {
          queries.push(sql);
          if (sql.includes("quest_schema_version")) {
            return { version: 4 };
          }
          return undefined;
        },
        run: async (sql) => {
          queries.push(sql);
        },
      }),
      write: async <T>(
        _operation: (executor: SqlExecutor) => Promise<T>,
      ): Promise<T> => {
        writeCalls += 1;
        throw new Error("Schema readiness must not start a write transaction.");
      },
    };

    await assertPublicationSchemaReady(database);
    expect(queries).toHaveLength(3);
    expect(writeCalls).toBe(0);
  });
});
