import { readFile } from "node:fs/promises";
import type { SqlExecutor, SqlRow, TursoDatabase } from "./client.js";

const WRITE_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const INITIAL_SCHEMA_OBJECT_COUNT = 10;

const versionOneMigrationUrl = new URL("./migrations/001_initial.sql", import.meta.url);
const versionTwoMigrationUrl = new URL(
  "./migrations/002_terminal_output.sql",
  import.meta.url,
);

function getSqlStatements(sql: string): string[] {
  return sql
    .replace(/--[^\r\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function normalizeInitialMigration(sql: string): string {
  const statements = getSqlStatements(sql);
  const hasExpectedEnvelope = statements.length >= 4 &&
    /^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statements[0] ?? "") &&
    /^BEGIN(?:\s+TRANSACTION)?$/i.test(statements[1] ?? "") &&
    /^COMMIT(?:\s+TRANSACTION)?$/i.test(statements.at(-1) ?? "");

  if (!hasExpectedEnvelope) {
    throw new Error("Initial Turso migration has an unsupported transaction envelope.");
  }

  const body = statements.slice(2, -1);

  if (
    body.length !== INITIAL_SCHEMA_OBJECT_COUNT ||
    body.some((statement) => !/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b/i.test(statement))
  ) {
    throw new Error("Initial Turso migration contains unsupported schema statements.");
  }

  return body.map((statement) => `${statement};`).join("\n");
}

function normalizeSchemaSql(sql: string): string {
  let normalized = "";
  let pendingWhitespace = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";

    if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }

      pendingWhitespace = true;
      continue;
    }

    if (character === "'") {
      if (
        pendingWhitespace &&
        normalized.length > 0 &&
        !/[,(=<>]$/.test(normalized)
      ) {
        normalized += " ";
      }

      pendingWhitespace = false;
      normalized += character;

      while (index + 1 < sql.length) {
        index += 1;
        normalized += sql[index];

        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 1;
          normalized += sql[index];
          continue;
        }

        if (sql[index] === "'") {
          break;
        }
      }

      continue;
    }

    if (/\s/.test(character)) {
      pendingWhitespace = true;
      continue;
    }

    if (/[(),=<>]/.test(character)) {
      normalized = normalized.trimEnd();
      normalized += character;
      pendingWhitespace = false;
      continue;
    }

    if (
      pendingWhitespace &&
      normalized.length > 0 &&
      !/[,(=<>]$/.test(normalized)
    ) {
      normalized += " ";
    }

    normalized += character.toLowerCase();
    pendingWhitespace = false;
  }

  return normalized.trim().replace(/;$/, "");
}

function readInteger(row: Record<string, unknown> | undefined, column: string): number {
  const value = row?.[column];

  if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") {
    throw new Error(`Turso schema query did not return ${column}.`);
  }

  const numberValue = Number(value);

  if (!Number.isSafeInteger(numberValue)) {
    throw new Error(`Turso schema returned an invalid ${column}.`);
  }

  return numberValue;
}

async function readSchemaVersion(executor: SqlExecutor): Promise<number> {
  const row = await executor.get("PRAGMA user_version");
  return readInteger(row, "user_version");
}

async function readUserSchemaObjects(executor: SqlExecutor): Promise<SqlRow[]> {
  return executor.all(
    "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name",
  );
}

async function readExpectedSchemaObjects(
  version: 1 | 2,
): Promise<Map<string, string>> {
  const initialSql = normalizeInitialMigration(
    await readFile(versionOneMigrationUrl, "utf8"),
  );
  const expectedObjects = new Map<string, string>();

  for (const statement of getSqlStatements(initialSql)) {
    const objectMatch = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(statement);

    if (objectMatch === null) {
      throw new Error("Initial Turso migration contains unsupported schema SQL.");
    }

    const objectType = (objectMatch[1] ?? "").toLowerCase();
    const objectName = objectMatch[2];

    if (objectName === undefined) {
      throw new Error("Initial Turso migration contains an unnamed schema object.");
    }

    expectedObjects.set(`${objectType}:${objectName}`, statement);
  }

  if (version === 2) {
    const terminalOutputStatements = getSqlStatements(
      await readFile(versionTwoMigrationUrl, "utf8"),
    );
    const addedColumns = terminalOutputStatements.map((statement) => {
      const columnMatch = /^ALTER\s+TABLE\s+session\s+ADD\s+COLUMN\s+([\s\S]+)$/i.exec(statement);

      if (columnMatch?.[1] === undefined) {
        throw new Error("Terminal output migration contains unsupported SQL.");
      }

      return columnMatch[1].trim();
    });
    const sessionKey = "table:session";
    const sessionSql = expectedObjects.get(sessionKey);

    if (sessionSql === undefined) {
      throw new Error("Terminal output migration does not match the expected session schema.");
    }

    const expectedSessionSql = sessionSql.replace(
      /(\bmenu_message_id\s+INTEGER\s*,)/i,
      `$1 ${addedColumns.join(", ")},`,
    );

    if (expectedSessionSql === sessionSql) {
      throw new Error("Terminal output migration does not match the expected session schema.");
    }

    expectedObjects.set(sessionKey, expectedSessionSql);
  }

  return expectedObjects;
}

async function assertSchemaObjects(
  executor: SqlExecutor,
  version: 1 | 2,
): Promise<void> {
  const expectedObjects = await readExpectedSchemaObjects(version);
  const actualObjects = await readUserSchemaObjects(executor);

  if (actualObjects.length !== expectedObjects.size) {
    throw new Error(`Turso schema version ${version} has an unsupported object set.`);
  }

  for (const row of actualObjects) {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error(`Turso schema version ${version} has an invalid schema object.`);
    }

    const expectedSql = expectedObjects.get(`${row.type}:${row.name}`);

    if (
      expectedSql === undefined ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expectedSql)
    ) {
      throw new Error(`Turso schema version ${version} has an unsupported definition for ${row.name}.`);
    }
  }

  for (const [table, requiredColumns] of [
    [
      "session",
      [
        "id",
        "quest_version_id",
        "owner_type",
        "owner_id",
        "status",
        "ink_state_json",
        "state_version",
        "outcome",
        "menu_message_id",
      ],
    ],
    ["quest", ["id", "title", "description", "genre", "available"]],
    ["quest_version", ["id", "quest_id", "version", "story_ref", "story_hash"]],
    [
      "turn",
      [
        "id",
        "session_id",
        "step_no",
        "ink_checkpoint_json",
        "scene_text",
        "choices_json",
        "default_choice_index",
        "vote_duration_ms",
        "deadline_at_ms",
        "remaining_ms",
        "decision_choice_index",
        "interactive_message_id",
      ],
    ],
    ["vote", ["turn_id", "voter_id", "choice_index", "cast_at_ms"]],
    ["processed_update", ["update_id", "processed_at_ms"]],
  ] as const) {
    const columnRows = await executor.all(`PRAGMA table_info(${table})`);
    const columns = columnRows.map((row) => row.name);
    const expectedColumns = version === 2 && table === "session"
      ? [...requiredColumns, "final_scene_text", "final_scene_tags_json"]
      : [...requiredColumns];

    if (columns.some((name) => typeof name !== "string") ||
      columns.join("\0") !== expectedColumns.join("\0")) {
      throw new Error(`Turso schema version ${version} has unsupported columns in ${table}.`);
    }
  }
}

async function migrateEmptyDatabase(executor: SqlExecutor): Promise<void> {
  const initialSql = await readFile(versionOneMigrationUrl, "utf8");
  const normalizedSql = normalizeInitialMigration(initialSql);
  await executor.exec(normalizedSql);
  await executor.run("PRAGMA user_version = 1");
  await assertSchemaObjects(executor, 1);

  const terminalOutputSql = await readFile(versionTwoMigrationUrl, "utf8");
  await executor.exec(terminalOutputSql);
  await executor.run("PRAGMA user_version = 2");
}

function isDatabaseBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const databaseError = error as { code?: unknown; rawCode?: unknown };
  return databaseError.code === "SQLITE_BUSY" || databaseError.code === "BUSY" ||
    (typeof databaseError.rawCode === "number" &&
      (databaseError.rawCode & 0xff) === 5);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureSchemaInTransaction(executor: SqlExecutor): Promise<void> {
  const version = await readSchemaVersion(executor);

  if (version > 2) {
    throw new Error(`Turso schema version ${version} is newer than this application supports.`);
  }

  if (version < 0) {
    throw new Error(`Turso schema version ${version} is invalid.`);
  }

  if (version === 0) {
    const schemaObjects = await readUserSchemaObjects(executor);

    if (schemaObjects.length !== 0) {
      throw new Error("Turso has unversioned schema objects; refusing to modify an unknown schema.");
    }

    await migrateEmptyDatabase(executor);
    await assertSchemaObjects(executor, 2);
    return;
  }

  if (version === 1) {
    await assertSchemaObjects(executor, 1);
    const terminalOutputSql = await readFile(versionTwoMigrationUrl, "utf8");
    await executor.exec(terminalOutputSql);
    await executor.run("PRAGMA user_version = 2");
  }

  await assertSchemaObjects(executor, 2);
}

export async function ensureSchema(database: TursoDatabase): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await database.write(ensureSchemaInTransaction);
      return;
    } catch (error) {
      const retryDelayMs = WRITE_LOCK_RETRY_DELAYS_MS[attempt];

      if (!isDatabaseBusy(error) || retryDelayMs === undefined) {
        throw error;
      }

      await wait(retryDelayMs);
    }
  }
}
