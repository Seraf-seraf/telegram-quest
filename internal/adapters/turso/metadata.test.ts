import { describe, expect, it } from "vitest";
import type { SqlExecutor, SqlParameter, SqlRow, TursoDatabase } from "./client.js";
import { createTursoMetadataStore } from "./metadata.js";

class CaptureDatabase implements TursoDatabase {
  public reads = 0;
  public queries: Array<{ sql: string; args: SqlParameter[] }> = [];
  public rows: SqlRow[] = [];

  public close(): void {}

  public async read<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.reads += 1;
    return operation({
      all: async (sql, ...args) => {
        this.queries.push({ sql, args });
        return this.rows;
      },
      exec: async () => {
        throw new Error("Unexpected exec.");
      },
      get: async () => {
        throw new Error("Unexpected get.");
      },
      run: async () => {
        throw new Error("Unexpected run.");
      },
    });
  }

  public async write<T>(_operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    throw new Error("Unexpected write.");
  }
}

describe("createTursoMetadataStore", () => {
  it("performs one exact quest-scoped lookup for all distinct names", async () => {
    const database = new CaptureDatabase();
    database.rows = [
      { name: "dark_corridor", kind: "image", value: "https://cdn.example/dark.jpg" },
      { name: "corridor_note", kind: "text", value: "A note." },
    ];
    const store = createTursoMetadataStore(database);

    await expect(store.getMany("quest-a", ["dark_corridor", "corridor_note", "dark_corridor"]))
      .resolves.toEqual(database.rows);

    expect(database.reads).toBe(1);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]).toMatchObject({
      sql: expect.stringContaining("quest_id = ?"),
      args: ["quest-a", "dark_corridor", "corridor_note"],
    });
    expect(database.queries[0]?.sql).toContain("name IN (?, ?)");
    expect(database.queries[0]?.sql).not.toContain("OR quest_id IS NULL");
  });

  it("uses only the global NULL namespace and skips empty lookups", async () => {
    const database = new CaptureDatabase();
    database.rows = [{ name: "menu.main.banner", kind: "image", value: "https://cdn.example/banner.jpg" }];
    const store = createTursoMetadataStore(database);

    await expect(store.getMany(null, ["menu.main.banner"]))
      .resolves.toEqual(database.rows);
    expect(database.queries[0]).toMatchObject({
      sql: expect.stringContaining("quest_id IS NULL"),
      args: ["menu.main.banner"],
    });

    await expect(store.getMany(null, [])).resolves.toEqual([]);
    expect(database.reads).toBe(1);
  });
});
