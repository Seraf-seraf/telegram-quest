import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import demoStory from "../ink/fixtures/demo.ink.json" with { type: "json" };
import type { SqlExecutor, SqlParameter, SqlRow, TursoDatabase } from "./client.js";

const WRITE_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const INITIAL_SCHEMA_OBJECT_COUNT = 10;
const SCHEMA_VERSION_TABLE_SQL = "CREATE TABLE quest_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version >= 1))";
const CURRENT_SCHEMA_VERSION = 4;
const DEMO_QUEST_ID = "telegram-quest-demo";
const DEMO_STORY_REFERENCE = "bundled:telegram-quest-demo-v1";

const versionOneMigrationUrl = new URL("./migrations/001_initial.sql", import.meta.url);
const versionTwoMigrationUrl = new URL(
  "./migrations/002_terminal_output.sql",
  import.meta.url,
);
const versionThreeMigrationUrl = new URL(
  "./migrations/003_quest_without_versions.sql",
  import.meta.url,
);
const versionFourMigrationUrl = new URL(
  "./migrations/004_content_metadata.sql",
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

    if (character === '"') {
      if (
        pendingWhitespace &&
        normalized.length > 0 &&
        !/[,(=<>]$/.test(normalized)
      ) {
        normalized += " ";
      }

      pendingWhitespace = false;
      let identifier = "";
      while (index + 1 < sql.length) {
        index += 1;
        const quotedCharacter = sql[index] ?? "";
        if (quotedCharacter === '"' && sql[index + 1] === '"') {
          identifier += '"';
          index += 1;
          continue;
        }
        if (quotedCharacter === '"') {
          break;
        }
        identifier += quotedCharacter;
      }

      normalized += identifier.toLowerCase();
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
  version: 1 | 2 | 3 | 4,
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

  if (version >= 2) {
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

  if (version >= 3) {
    for (const key of [
      "table:quest",
      "table:quest_version",
      "table:session",
      "table:turn",
      "table:vote",
      "index:ix_session_quest_version",
    ]) {
      expectedObjects.delete(key);
    }

    const v3Statements = getSqlStatements(
      await readFile(versionThreeMigrationUrl, "utf8"),
    );
    for (const statement of v3Statements) {
      const objectMatch = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(statement);
      if (objectMatch === null) {
        continue;
      }

      const objectType = (objectMatch[1] ?? "").toLowerCase();
      const objectName = objectMatch[2];
      if (objectName === undefined) {
        throw new Error("Quest migration contains an unnamed schema object.");
      }

      const finalSql = statement.replace(/_new\b/g, "");
      const finalName = objectName.replace(/_new\b/g, "");
      expectedObjects.set(`${objectType}:${finalName}`, finalSql);
    }
  }

  if (version === 4) {
    const v4Statements = getSqlStatements(
      await readFile(versionFourMigrationUrl, "utf8"),
    );
    for (const statement of v4Statements) {
      const alterMatch = /^ALTER\s+TABLE\s+turn\s+ADD\s+COLUMN\s+([\s\S]+)$/i.exec(statement);
      if (alterMatch?.[1] !== undefined) {
        const turnSql = expectedObjects.get("table:turn");
        if (turnSql === undefined) {
          throw new Error("Content metadata migration does not match the expected turn schema.");
        }
        const expectedTurnSql = turnSql.replace(
          /(interactive_message_id\s+INTEGER\s*,)/i,
          `$1 ${alterMatch[1].trim()},`,
        );
        if (expectedTurnSql === turnSql) {
          throw new Error("Content metadata migration does not match the expected turn schema.");
        }
        expectedObjects.set("table:turn", expectedTurnSql);
        continue;
      }

      const objectMatch = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(statement);
      if (objectMatch === null || objectMatch[2] === undefined) {
        throw new Error("Content metadata migration contains unsupported schema SQL.");
      }
      expectedObjects.set(`${objectMatch[1]!.toLowerCase()}:${objectMatch[2]}`, statement);
    }
  }

  return expectedObjects;
}

async function assertSchemaObjects(
  executor: SqlExecutor,
  version: 1 | 2 | 3 | 4,
  withVersionTable = false,
): Promise<void> {
  const expectedObjects = await readExpectedSchemaObjects(version);
  if (withVersionTable) {
    expectedObjects.set("table:quest_schema_version", SCHEMA_VERSION_TABLE_SQL);
  }
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

  const requiredTables: Array<[string, string[]]> = version >= 3
    ? [
      ["session", [
        "id", "quest_id", "owner_type", "owner_id", "status", "ink_state_json",
        "state_version", "outcome", "menu_message_id", "final_scene_text",
        "final_scene_tags_json",
      ]],
      ["quest", ["id", "title", "description", "genre", "available", "story_json"]],
      ["turn", [
        "id", "session_id", "step_no", "ink_checkpoint_json", "scene_text", "choices_json",
        "default_choice_index", "vote_duration_ms", "deadline_at_ms", "remaining_ms",
        "decision_choice_index", "interactive_message_id",
      ]],
      ["vote", ["turn_id", "voter_id", "choice_index", "cast_at_ms"]],
      ["processed_update", ["update_id", "processed_at_ms"]],
    ]
    : [
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
    ];

  if (version === 4) {
    requiredTables.push(["content_metadata", ["id", "quest_id", "name", "kind", "value"]]);
  }

  for (const [table, requiredColumns] of requiredTables) {
    const columnRows = await executor.all(`PRAGMA table_info(${table})`);
    const columns = columnRows.map((row) => row.name);
    const expectedColumns = version === 2 && table === "session"
      ? [...requiredColumns, "final_scene_text", "final_scene_tags_json"]
      : version === 4 && table === "turn"
      ? [...requiredColumns, "scene_tags_json"]
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
  await assertSchemaObjects(executor, 1);

  const terminalOutputSql = await readFile(versionTwoMigrationUrl, "utf8");
  await executor.exec(terminalOutputSql);
}

function readRequiredString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Turso migration found invalid ${column} data.`);
  }
  return value;
}

function readNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Turso migration found invalid ${column} data.`);
  }
  return value as string | null;
}

function readSqlParameter(row: SqlRow, column: string): SqlParameter {
  const value = row[column];
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(`Turso migration found invalid ${column} data.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObjectText(value: string): boolean {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

function unwrapStoredInkState(
  value: unknown,
  expectedStoryHash: string,
  table: "session" | "turn",
  id: string,
  nullable: boolean,
): string | null {
  if (value === null && nullable) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Turso migration cannot restore saved Ink state in ${table} ${id}.`);
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(value);
  } catch {
    throw new Error(`Turso migration cannot restore saved Ink state in ${table} ${id}.`);
  }

  if (!isRecord(envelope)) {
    throw new Error(`Turso migration cannot restore saved Ink state in ${table} ${id}.`);
  }

  const fingerprint = envelope.storyFingerprint;
  const inkStateJson = envelope.inkStateJson;
  if (
    envelope.formatVersion !== 1 ||
    typeof fingerprint !== "string" ||
    fingerprint.toLowerCase() !== expectedStoryHash.toLowerCase() ||
    typeof inkStateJson !== "string" ||
    !isJsonObjectText(inkStateJson)
  ) {
    throw new Error(`Turso migration cannot restore saved Ink state in ${table} ${id}.`);
  }

  return inkStateJson;
}

async function assertCopiedRows(
  executor: SqlExecutor,
  table: string,
  columns: readonly string[],
  orderBy: string,
  expectedRows: readonly SqlRow[],
): Promise<void> {
  const rows = await executor.all(
    `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`,
  );
  if (rows.length !== expectedRows.length) {
    throw new Error(`Turso migration did not preserve ${table} rows.`);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const actual = rows[index];
    const expected = expectedRows[index];
    if (actual === undefined || expected === undefined ||
      columns.some((column) => actual[column] !== expected[column])) {
      throw new Error(`Turso migration did not preserve ${table} data.`);
    }
  }
}

async function migrateVersionTwoToThree(executor: SqlExecutor): Promise<void> {
  const sourceStoryJson = JSON.stringify(demoStory);
  const sourceStoryHash = createHash("sha256").update(sourceStoryJson).digest("hex");
  const foreignKeyViolationsBefore = await executor.all("PRAGMA foreign_key_check");
  if (foreignKeyViolationsBefore.length > 0) {
    throw new Error("Turso migration found invalid existing foreign-key data.");
  }

  const quests = await executor.all(
    "SELECT id, title, description, genre, available FROM quest ORDER BY id COLLATE BINARY",
  );
  const versions = await executor.all(
    "SELECT id, quest_id, version, story_ref, story_hash FROM quest_version ORDER BY quest_id, id",
  );
  const versionById = new Map<string, { questId: string; storyHash: string }>();
  const versionsByQuest = new Map<string, Array<{ id: string; storyRef: string; storyHash: string }>>();

  for (const row of versions) {
    const id = readRequiredString(row, "id");
    const questId = readRequiredString(row, "quest_id");
    const storyRef = readRequiredString(row, "story_ref");
    const storyHash = readRequiredString(row, "story_hash");
    if (!/^[a-f\d]{64}$/i.test(storyHash)) {
      throw new Error(`Turso migration found an invalid story hash for quest ${questId}.`);
    }

    versionById.set(id, { questId, storyHash });
    const questVersions = versionsByQuest.get(questId) ?? [];
    questVersions.push({ id, storyRef, storyHash });
    versionsByQuest.set(questId, questVersions);
  }

  const storyByQuest = new Map<string, string>();
  for (const row of quests) {
    const questId = readRequiredString(row, "id");
    const questVersions = versionsByQuest.get(questId) ?? [];
    if (questVersions.length === 0) {
      throw new Error(`Turso migration cannot resolve the story for quest ${questId}.`);
    }

    const storyRefs = new Set(questVersions.map((version) => version.storyRef));
    const storyHashes = new Set(questVersions.map((version) => version.storyHash.toLowerCase()));
    if (storyRefs.size !== 1 || storyHashes.size !== 1) {
      throw new Error(`Turso migration found ambiguous story versions for quest ${questId}.`);
    }

    const storyRef = questVersions[0]?.storyRef;
    const storyHash = questVersions[0]?.storyHash.toLowerCase();
    if (
      questId !== DEMO_QUEST_ID ||
      storyRef !== DEMO_STORY_REFERENCE ||
      storyHash !== sourceStoryHash
    ) {
      throw new Error(`Turso migration cannot resolve the story for quest ${questId}.`);
    }
    storyByQuest.set(questId, sourceStoryJson);
  }

  const oldSessionRows = await executor.all(
    `SELECT id, quest_version_id, owner_type, owner_id, status, ink_state_json,
            state_version, outcome, menu_message_id, final_scene_text, final_scene_tags_json
       FROM session ORDER BY id COLLATE BINARY`,
  );
  const expectedSessions: SqlRow[] = [];
  const sessionStoryById = new Map<string, { questId: string; storyHash: string; status: string }>();

  for (const row of oldSessionRows) {
    const id = readRequiredString(row, "id");
    const versionId = readRequiredString(row, "quest_version_id");
    const version = versionById.get(versionId);
    if (version === undefined || storyByQuest.get(version.questId) === undefined) {
      throw new Error(`Turso migration cannot resolve the story for session ${id}.`);
    }

    const expected: SqlRow = {
      id,
      quest_id: version.questId,
      owner_type: readRequiredString(row, "owner_type"),
      owner_id: readRequiredString(row, "owner_id"),
      status: readRequiredString(row, "status"),
      ink_state_json: unwrapStoredInkState(
        row.ink_state_json,
        version.storyHash,
        "session",
        id,
        true,
      ),
      state_version: readSqlParameter(row, "state_version"),
      outcome: readNullableString(row, "outcome"),
      menu_message_id: readSqlParameter(row, "menu_message_id"),
      final_scene_text: readNullableString(row, "final_scene_text"),
      final_scene_tags_json: readNullableString(row, "final_scene_tags_json"),
    };
    expectedSessions.push(expected);
    sessionStoryById.set(id, {
      questId: version.questId,
      storyHash: version.storyHash,
      status: expected.status as string,
    });
  }

  const oldTurnRows = await executor.all(
    `SELECT id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
            default_choice_index, vote_duration_ms, deadline_at_ms, remaining_ms,
            decision_choice_index, interactive_message_id
       FROM turn ORDER BY id COLLATE BINARY`,
  );
  const expectedTurns: SqlRow[] = [];
  const turnsBySession = new Map<string, SqlRow[]>();

  for (const row of oldTurnRows) {
    const id = readRequiredString(row, "id");
    const sessionId = readRequiredString(row, "session_id");
    const sessionStory = sessionStoryById.get(sessionId);
    if (sessionStory === undefined) {
      throw new Error(`Turso migration found an orphan turn ${id}.`);
    }

    const expected: SqlRow = {
      id,
      session_id: sessionId,
      step_no: readSqlParameter(row, "step_no"),
      ink_checkpoint_json: unwrapStoredInkState(
        row.ink_checkpoint_json,
        sessionStory.storyHash,
        "turn",
        id,
        false,
      ),
      scene_text: readRequiredString(row, "scene_text"),
      choices_json: readRequiredString(row, "choices_json"),
      default_choice_index: readSqlParameter(row, "default_choice_index"),
      vote_duration_ms: readSqlParameter(row, "vote_duration_ms"),
      deadline_at_ms: readSqlParameter(row, "deadline_at_ms"),
      remaining_ms: readSqlParameter(row, "remaining_ms"),
      decision_choice_index: readSqlParameter(row, "decision_choice_index"),
      interactive_message_id: readSqlParameter(row, "interactive_message_id"),
    };
    expectedTurns.push(expected);
    const sessionTurns = turnsBySession.get(sessionId) ?? [];
    sessionTurns.push(expected);
    turnsBySession.set(sessionId, sessionTurns);
  }

  for (const session of expectedSessions) {
    const status = session.status as string;
    if (status !== "active" && status !== "paused") {
      continue;
    }

    const currentTurns = (turnsBySession.get(session.id as string) ?? [])
      .filter((turn) => turn.decision_choice_index === null);
    if (
      currentTurns.length !== 1 ||
      session.ink_state_json !== currentTurns[0]?.ink_checkpoint_json
    ) {
      throw new Error(`Turso migration found unrestorable session ${String(session.id)}.`);
    }
  }

  const oldVoteRows = await executor.all(
    "SELECT turn_id, voter_id, choice_index, cast_at_ms FROM vote ORDER BY turn_id, voter_id",
  );
  const expectedVotes = oldVoteRows.map((row): SqlRow => ({
    turn_id: readRequiredString(row, "turn_id"),
    voter_id: readRequiredString(row, "voter_id"),
    choice_index: readSqlParameter(row, "choice_index"),
    cast_at_ms: readSqlParameter(row, "cast_at_ms"),
  }));
  const processedUpdates = await executor.all(
    "SELECT update_id, processed_at_ms FROM processed_update ORDER BY update_id",
  );

  const expectedQuests = quests.map((row): SqlRow => {
    const id = readRequiredString(row, "id");
    const storyJson = storyByQuest.get(id);
    if (storyJson === undefined) {
      throw new Error(`Turso migration cannot resolve the story for quest ${id}.`);
    }
    return {
      id,
      title: readRequiredString(row, "title"),
      description: readRequiredString(row, "description"),
      genre: readRequiredString(row, "genre"),
      available: readSqlParameter(row, "available"),
      story_json: storyJson,
    };
  });

  const migrationStatements = getSqlStatements(
    await readFile(versionThreeMigrationUrl, "utf8"),
  );
  const tableStatements = migrationStatements.filter((statement) => /^CREATE\s+TABLE\b/i.test(statement));
  const indexStatements = migrationStatements.filter((statement) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement));
  if (tableStatements.length !== 4 || indexStatements.length !== 4) {
    throw new Error("Quest migration contains an unsupported schema definition.");
  }
  for (const statement of tableStatements) {
    await executor.exec(`${statement};`);
  }

  for (const quest of expectedQuests) {
    await executor.run(
      `INSERT INTO quest_new (id, title, description, genre, available, story_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      quest.id as string,
      quest.title as string,
      quest.description as string,
      quest.genre as string,
      quest.available as SqlParameter,
      quest.story_json as string,
    );
  }
  for (const session of expectedSessions) {
    await executor.run(
      `INSERT INTO session_new (
         id, quest_id, owner_type, owner_id, status, ink_state_json, state_version,
         outcome, menu_message_id, final_scene_text, final_scene_tags_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id as string,
      session.quest_id as string,
      session.owner_type as string,
      session.owner_id as string,
      session.status as string,
      session.ink_state_json as string | null,
      session.state_version as SqlParameter,
      session.outcome as string | null,
      session.menu_message_id as SqlParameter,
      session.final_scene_text as string | null,
      session.final_scene_tags_json as string | null,
    );
  }
  for (const turn of expectedTurns) {
    await executor.run(
      `INSERT INTO turn_new (
         id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
         default_choice_index, vote_duration_ms, deadline_at_ms, remaining_ms,
         decision_choice_index, interactive_message_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turn.id as string,
      turn.session_id as string,
      turn.step_no as SqlParameter,
      turn.ink_checkpoint_json as string,
      turn.scene_text as string,
      turn.choices_json as string,
      turn.default_choice_index as SqlParameter,
      turn.vote_duration_ms as SqlParameter,
      turn.deadline_at_ms as SqlParameter,
      turn.remaining_ms as SqlParameter,
      turn.decision_choice_index as SqlParameter,
      turn.interactive_message_id as SqlParameter,
    );
  }
  for (const vote of expectedVotes) {
    await executor.run(
      `INSERT INTO vote_new (turn_id, voter_id, choice_index, cast_at_ms)
       VALUES (?, ?, ?, ?)`,
      vote.turn_id as string,
      vote.voter_id as string,
      vote.choice_index as SqlParameter,
      vote.cast_at_ms as SqlParameter,
    );
  }

  for (const table of ["vote", "turn", "session", "quest_version", "quest"]) {
    await executor.exec(`DROP TABLE ${table};`);
  }
  await executor.exec("ALTER TABLE quest_new RENAME TO quest;");
  await executor.exec("ALTER TABLE session_new RENAME TO session;");
  await executor.exec("ALTER TABLE turn_new RENAME TO turn;");
  await executor.exec("ALTER TABLE vote_new RENAME TO vote;");
  for (const statement of indexStatements) {
    await executor.exec(`${statement.replace(/_new\b/g, "")};`);
  }

  await assertCopiedRows(
    executor,
    "quest",
    ["id", "title", "description", "genre", "available", "story_json"],
    "id COLLATE BINARY",
    expectedQuests,
  );
  await assertCopiedRows(
    executor,
    "session",
    [
      "id", "quest_id", "owner_type", "owner_id", "status", "ink_state_json",
      "state_version", "outcome", "menu_message_id", "final_scene_text", "final_scene_tags_json",
    ],
    "id COLLATE BINARY",
    expectedSessions,
  );
  await assertCopiedRows(
    executor,
    "turn",
    [
      "id", "session_id", "step_no", "ink_checkpoint_json", "scene_text", "choices_json",
      "default_choice_index", "vote_duration_ms", "deadline_at_ms", "remaining_ms",
      "decision_choice_index", "interactive_message_id",
    ],
    "id COLLATE BINARY",
    expectedTurns,
  );
  await assertCopiedRows(
    executor,
    "vote",
    ["turn_id", "voter_id", "choice_index", "cast_at_ms"],
    "turn_id, voter_id",
    expectedVotes,
  );
  await assertCopiedRows(
    executor,
    "processed_update",
    ["update_id", "processed_at_ms"],
    "update_id",
    processedUpdates,
  );

  const foreignKeyViolationsAfter = await executor.all("PRAGMA foreign_key_check");
  if (foreignKeyViolationsAfter.length > 0) {
    throw new Error("Turso migration produced invalid foreign-key data.");
  }
  await assertSchemaObjects(executor, 3, true);
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

async function migrateVersionThreeToFour(executor: SqlExecutor): Promise<void> {
  await executor.exec(await readFile(versionFourMigrationUrl, "utf8"));
  await assertSchemaObjects(executor, 4, true);
}

async function advanceStoredVersion(
  executor: SqlExecutor,
  fromVersion: number,
  toVersion: number,
): Promise<void> {
  await executor.run(
    "UPDATE quest_schema_version SET version = ? WHERE id = 1 AND version = ?",
    toVersion,
    fromVersion,
  );
  const rows = await executor.all("SELECT id, version FROM quest_schema_version");
  if (rows.length !== 1 || readInteger(rows[0], "id") !== 1 ||
    readInteger(rows[0], "version") !== toVersion) {
    throw new Error("Turso schema version could not be advanced to the current version.");
  }
}

async function ensureSchemaInTransaction(executor: SqlExecutor): Promise<void> {
  const version = await readSchemaVersion(executor);

  if (version > 2) {
    throw new Error(`Turso schema version ${version} is newer than this application supports.`);
  }

  if (version < 0) {
    throw new Error(`Turso schema version ${version} is invalid.`);
  }

  const schemaObjects = await readUserSchemaObjects(executor);
  const hasVersionTable = schemaObjects.some((row) => row.name === "quest_schema_version");
  let storedVersion: number;
  if (hasVersionTable) {
    const rows = await executor.all("SELECT id, version FROM quest_schema_version");
    if (rows.length !== 1 || readInteger(rows[0], "id") !== 1) {
      throw new Error("Turso schema version table contains an unsupported version.");
    }
    storedVersion = readInteger(rows[0], "version");
    if (storedVersion === CURRENT_SCHEMA_VERSION) {
      await assertSchemaObjects(executor, 4, true);
      return;
    }
    if (storedVersion === 3) {
      await assertSchemaObjects(executor, 3, true);
    } else if (storedVersion === 2) {
      await assertSchemaObjects(executor, 2, true);
    } else {
      throw new Error("Turso schema version table contains an unsupported version.");
    }
  } else {
    if (version === 0) {
      if (schemaObjects.length !== 0) {
        throw new Error("Turso has unversioned schema objects; refusing to modify an unknown schema.");
      }

      await migrateEmptyDatabase(executor);
    } else if (version === 1) {
      await assertSchemaObjects(executor, 1);
      const terminalOutputSql = await readFile(versionTwoMigrationUrl, "utf8");
      await executor.exec(terminalOutputSql);
    } else if (version === 2) {
      await assertSchemaObjects(executor, 2);
    }

    await assertSchemaObjects(executor, 2);
    await executor.exec(SCHEMA_VERSION_TABLE_SQL);
    await executor.run("INSERT INTO quest_schema_version (id, version) VALUES (1, 2)");
    await assertSchemaObjects(executor, 2, true);
    storedVersion = 2;
  }

  if (storedVersion === 2) {
    await migrateVersionTwoToThree(executor);
    await advanceStoredVersion(executor, 2, 3);
    await assertSchemaObjects(executor, 3, true);
    storedVersion = 3;
  }

  if (storedVersion === 3) {
    await migrateVersionThreeToFour(executor);
    await advanceStoredVersion(executor, 3, 4);
    await assertSchemaObjects(executor, 4, true);
  }
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
