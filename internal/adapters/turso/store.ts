import type {
  Choice,
  FinalScene,
  Outcome,
  QuestVersion,
  Session,
  SessionOwner,
  SessionStatus,
  Turn,
} from "../../domain/model.js";
import {
  SessionError,
  type CreateSessionRecord,
  type SessionQuestVersion,
  type SessionStore,
  type StartSessionRecord,
} from "../../app/session-store.js";
import type { SqlExecutor, SqlRow, TursoDatabase } from "./client.js";

function invalidStorageData(label: string): SessionError {
  return new SessionError("STORAGE_FAILURE", `Stored ${label} is invalid.`);
}

function readString(row: SqlRow, column: string): string {
  const value = row[column];

  if (typeof value !== "string") {
    throw invalidStorageData(column);
  }

  return value;
}

function readNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];

  if (value !== null && typeof value !== "string") {
    throw invalidStorageData(column);
  }

  return value as string | null;
}

function readInteger(row: SqlRow, column: string): number {
  const value = row[column];

  if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") {
    throw invalidStorageData(column);
  }

  const result = Number(value);

  if (!Number.isSafeInteger(result)) {
    throw invalidStorageData(column);
  }

  return result;
}

function readNullableInteger(row: SqlRow, column: string): number | null {
  const value = row[column];

  if (value === null) {
    return null;
  }

  return readInteger(row, column);
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function readOwner(row: SqlRow): SessionOwner {
  const type = readString(row, "owner_type");
  const id = readString(row, "owner_id");

  if (type !== "group" && type !== "user") {
    throw invalidStorageData("session owner type");
  }

  return { type, id };
}

function readStatus(row: SqlRow): SessionStatus {
  const status = readString(row, "status");

  if (
    status !== "created" &&
    status !== "active" &&
    status !== "paused" &&
    status !== "completed"
  ) {
    throw invalidStorageData("session status");
  }

  return status;
}

function parseChoicesJson(json: string): Choice[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SessionError("STORAGE_FAILURE", "Stored turn choices are invalid.", { cause: error });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw invalidStorageData("turn choices");
  }

  const choiceIndexes = new Set<number>();
  return parsed.map((choice): Choice => {
    if (
      typeof choice !== "object" ||
      choice === null ||
      !Number.isSafeInteger(choice.index) ||
      choice.index < 0 ||
      choice.index >= parsed.length ||
      choiceIndexes.has(choice.index) ||
      typeof choice.text !== "string" ||
      !Array.isArray(choice.tags) ||
      choice.tags.some((tag: unknown) => typeof tag !== "string")
    ) {
      throw invalidStorageData("turn choice");
    }

    choiceIndexes.add(choice.index);
    return { index: choice.index, text: choice.text, tags: [...choice.tags] };
  });
}

function mapTurn(row: SqlRow): Turn {
  const decisionChoiceIndex = readNullableInteger(row, "decision_choice_index");

  return {
    id: readString(row, "id"),
    stepNumber: readInteger(row, "step_no"),
    inkCheckpoint: readString(row, "ink_checkpoint_json"),
    sceneText: readString(row, "scene_text"),
    choices: parseChoicesJson(readString(row, "choices_json")),
    decision: decisionChoiceIndex === null
      ? null
      : { choiceIndex: decisionChoiceIndex },
  };
}

function parseFinalScene(text: string | null, tagsJson: string | null): FinalScene | null {
  if (text === null && tagsJson === null) {
    return null;
  }

  if (text === null || tagsJson === null) {
    throw invalidStorageData("final scene");
  }

  let tags: unknown;

  try {
    tags = JSON.parse(tagsJson);
  } catch (error) {
    throw new SessionError("STORAGE_FAILURE", "Stored final scene tags are invalid.", { cause: error });
  }

  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw invalidStorageData("final scene tags");
  }

  return { text, tags };
}

function mapSession(row: SqlRow, turns: Turn[] = []): Session {
  const finalScene = parseFinalScene(
    readNullableString(row, "final_scene_text"),
    readNullableString(row, "final_scene_tags_json"),
  );
  const outcome = readNullableString(row, "outcome") as Outcome | null;

  return {
    id: readString(row, "id"),
    questVersionId: readString(row, "quest_version_id"),
    owner: readOwner(row),
    status: readStatus(row),
    inkState: readNullableString(row, "ink_state_json"),
    stateVersion: readInteger(row, "state_version"),
    turns,
    outcome,
    finalScene,
  };
}

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const databaseError = error as { code?: unknown; rawCode?: unknown };
  return (typeof databaseError.code === "string" &&
    databaseError.code.toUpperCase().includes("CONSTRAINT")) ||
    (typeof databaseError.rawCode === "number" &&
      (databaseError.rawCode & 0xff) === 19);
}

function asStorageFailure(error: unknown): SessionError {
  if (error instanceof SessionError) {
    return error;
  }

  return new SessionError("STORAGE_FAILURE", "Session storage operation failed.", {
    cause: error,
  });
}

async function readQuestVersion(
  executor: SqlExecutor,
  questVersionId: string,
): Promise<SessionQuestVersion | null> {
  const row = await executor.get(
    `SELECT quest_version.id AS version_id,
            quest_version.quest_id AS quest_id,
            quest_version.version AS version,
            quest_version.story_ref AS story_ref,
            quest_version.story_hash AS story_hash,
            quest.available AS quest_available
       FROM quest_version
       JOIN quest ON quest.id = quest_version.quest_id
      WHERE quest_version.id = ?`,
    questVersionId,
  );

  if (row === undefined) {
    return null;
  }

  const questVersion: QuestVersion = {
    id: readString(row, "version_id"),
    questId: readString(row, "quest_id"),
    version: readString(row, "version"),
    storyReference: readString(row, "story_ref"),
    storyHash: readString(row, "story_hash"),
  };
  const available = readInteger(row, "quest_available");

  if (available !== 0 && available !== 1) {
    throw invalidStorageData("quest availability");
  }

  return { questVersion, questAvailable: available === 1 };
}

async function readSessionRow(
  executor: SqlExecutor,
  sessionId: string,
): Promise<SqlRow | undefined> {
  return executor.get(
    `SELECT id, quest_version_id, owner_type, owner_id, status, ink_state_json,
            state_version, outcome, final_scene_text, final_scene_tags_json
       FROM session
      WHERE id = ?`,
    sessionId,
  );
}

function assertOwnerMatches(row: SqlRow, owner: SessionOwner): void {
  const storedOwner = readOwner(row);

  if (storedOwner.type !== owner.type || storedOwner.id !== owner.id) {
    throw new SessionError("FORBIDDEN_OWNER", "Session belongs to another owner.");
  }
}

async function readTurns(
  executor: SqlExecutor,
  sessionId: string,
): Promise<Turn[]> {
  const rows = await executor.all(
    `SELECT id, step_no, ink_checkpoint_json, scene_text, choices_json, decision_choice_index
       FROM turn
      WHERE session_id = ?
      ORDER BY step_no`,
    sessionId,
  );
  return rows.map(mapTurn);
}

async function requireOwnedSession(
  executor: SqlExecutor,
  owner: SessionOwner,
  sessionId: string,
): Promise<SqlRow> {
  const row = await readSessionRow(executor, sessionId);

  if (row === undefined) {
    throw new SessionError("NOT_FOUND", "Session was not found.");
  }

  assertOwnerMatches(row, owner);
  return row;
}

async function readSession(
  executor: SqlExecutor,
  owner: SessionOwner,
  sessionId: string,
): Promise<Session> {
  const rows = await executor.all(
    `SELECT session.id, session.quest_version_id, session.owner_type, session.owner_id,
            session.status, session.ink_state_json, session.state_version, session.outcome,
            session.final_scene_text, session.final_scene_tags_json,
            turn.id AS current_turn_id,
            turn.step_no AS current_step_no,
            turn.ink_checkpoint_json AS current_ink_checkpoint_json,
            turn.scene_text AS current_scene_text,
            turn.choices_json AS current_choices_json,
            turn.decision_choice_index AS current_decision_choice_index
       FROM session
       LEFT JOIN turn
         ON turn.session_id = session.id AND turn.decision_choice_index IS NULL
      WHERE session.id = ?
      ORDER BY turn.step_no DESC
      LIMIT 2`,
    sessionId,
  );

  if (rows.length === 0) {
    throw new SessionError("NOT_FOUND", "Session was not found.");
  }

  if (rows.length > 1) {
    throw invalidStorageData("open session turns");
  }

  const row = rows[0]!;
  assertOwnerMatches(row, owner);
  const currentTurnId = readNullableString(row, "current_turn_id");
  const currentTurns = currentTurnId === null
    ? []
    : [mapTurn({
      id: currentTurnId,
      step_no: readInteger(row, "current_step_no"),
      ink_checkpoint_json: readString(row, "current_ink_checkpoint_json"),
      scene_text: readString(row, "current_scene_text"),
      choices_json: readString(row, "current_choices_json"),
      decision_choice_index: readNullableInteger(row, "current_decision_choice_index"),
    })];

  const status = readStatus(row);
  if ((status === "active" || status === "paused") !== (currentTurns.length === 1)) {
    throw invalidStorageData("session current turn");
  }

  return mapSession(row, currentTurns);
}

function assertVersionAvailable(details: SessionQuestVersion | null): SessionQuestVersion {
  if (details === null) {
    throw new SessionError("NOT_FOUND", "Quest version was not found.");
  }

  if (!details.questAvailable) {
    throw new SessionError("INVALID_TRANSITION", "Quest is not available.");
  }

  return details;
}

function validateActiveStart(input: Extract<StartSessionRecord, { kind: "active" }>): void {
  const { turn } = input.initialTurn;
  const voteDurationMs = input.initialTurn.voteDurationMs;
  const defaultChoiceIndex = input.initialTurn.defaultChoiceIndex;

  if (
    turn.stepNumber !== 1 ||
    turn.decision !== null ||
    !Array.isArray(turn.choices) ||
    turn.choices.length === 0 ||
    turn.choices.some((choice) =>
      typeof choice !== "object" ||
      choice === null ||
      !Number.isSafeInteger(choice.index) ||
      choice.index < 0 ||
      choice.index >= turn.choices.length ||
      typeof choice.text !== "string" ||
      !Array.isArray(choice.tags) ||
      choice.tags.some((tag) => typeof tag !== "string")
    ) ||
    input.expectedStateVersion < 0 ||
    !Number.isSafeInteger(input.expectedStateVersion) ||
    !isJsonObject(input.inkState) ||
    turn.id.length === 0 ||
    !isJsonObject(turn.inkCheckpoint) ||
    typeof turn.sceneText !== "string" ||
    input.questVersionId.length === 0 ||
    !/^[a-f\d]{64}$/i.test(input.storyHash)
  ) {
    throw new SessionError("INVALID_TRANSITION", "Initial session turn is invalid.");
  }

  if (input.owner.type === "group") {
    if (
      voteDurationMs === null ||
      !Number.isSafeInteger(voteDurationMs) ||
      voteDurationMs <= 0 ||
      defaultChoiceIndex === null
    ) {
      throw new SessionError("INVALID_TRANSITION", "Group turn policy is invalid.");
    }

    if (
      !Number.isSafeInteger(defaultChoiceIndex) ||
      defaultChoiceIndex < 0 ||
      defaultChoiceIndex >= turn.choices.length ||
      !turn.choices.some((choice) => choice.index === defaultChoiceIndex)
    ) {
      throw new SessionError("INVALID_CHOICE", "Group default choice is not available.");
    }
  } else if (voteDurationMs !== null || defaultChoiceIndex !== null) {
    throw new SessionError("INVALID_TRANSITION", "Personal turns cannot have a vote policy.");
  }
}

function validateCompletedStart(
  input: Extract<StartSessionRecord, { kind: "completed" }>,
): void {
  if (
    input.expectedStateVersion < 0 ||
    !Number.isSafeInteger(input.expectedStateVersion) ||
    !isJsonObject(input.inkState) ||
    input.questVersionId.length === 0 ||
    !/^[a-f\d]{64}$/i.test(input.storyHash) ||
    typeof input.finalScene.text !== "string" ||
    !Array.isArray(input.finalScene.tags) ||
    input.finalScene.tags.some((tag) => typeof tag !== "string")
  ) {
    throw new SessionError("INVALID_TRANSITION", "Completed session output is invalid.");
  }
}

export function createTursoSessionStore(database: TursoDatabase): SessionStore {
  async function inRead<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await database.read(operation);
    } catch (error) {
      throw asStorageFailure(error);
    }
  }

  async function inWrite<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await database.write(operation);
    } catch (error) {
      throw asStorageFailure(error);
    }
  }

  return {
    async getQuestVersion(questVersionId: string): Promise<SessionQuestVersion | null> {
      return inRead((executor) => readQuestVersion(executor, questVersionId));
    },

    async createSession(input: CreateSessionRecord): Promise<Session> {
      return inWrite(async (executor) => {
        const details = assertVersionAvailable(
          await readQuestVersion(executor, input.questVersionId),
        );

        try {
          await executor.run(
            "INSERT INTO processed_update (update_id, processed_at_ms) VALUES (?, ?)",
            input.operationId,
            input.processedAtMs,
          );
        } catch (error) {
          if (isConstraintViolation(error)) {
            throw new SessionError("DUPLICATE_OPERATION", "Operation was already processed.");
          }

          throw error;
        }

        try {
          await executor.run(
            `INSERT INTO session (id, quest_version_id, owner_type, owner_id)
             VALUES (?, ?, ?, ?)`,
            input.sessionId,
            details.questVersion.id,
            input.owner.type,
            input.owner.id,
          );
        } catch (error) {
          if (isConstraintViolation(error)) {
            throw new SessionError("CONFLICT", "Session could not be created for this owner.");
          }

          throw error;
        }

        const row = await readSessionRow(executor, input.sessionId);

        if (row === undefined) {
          throw invalidStorageData("new session");
        }

        return mapSession(row);
      });
    },

    async getSession(owner: SessionOwner, sessionId: string): Promise<Session> {
      return inRead((executor) => readSession(executor, owner, sessionId));
    },

    async listTurns(owner: SessionOwner, sessionId: string): Promise<Turn[]> {
      return inRead(async (executor) => {
        await requireOwnedSession(executor, owner, sessionId);
        return readTurns(executor, sessionId);
      });
    },

    async startSession(input: StartSessionRecord): Promise<Session> {
      if (input.kind === "active") {
        validateActiveStart(input);
      } else {
        validateCompletedStart(input);
      }

      return inWrite(async (executor) => {
        const row = await requireOwnedSession(executor, input.owner, input.sessionId);
        const currentStateVersion = readInteger(row, "state_version");

        if (currentStateVersion !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        if (readStatus(row) !== "created") {
          throw new SessionError("INVALID_TRANSITION", "Session cannot be started.");
        }

        if (readString(row, "quest_version_id") !== input.questVersionId) {
          throw new SessionError("STORY_MISMATCH", "Session is pinned to another quest version.");
        }

        const latestVersion = assertVersionAvailable(
          await readQuestVersion(executor, input.questVersionId),
        );
        if (
          latestVersion.questVersion.storyHash.toLowerCase() !== input.storyHash.toLowerCase()
        ) {
          throw new SessionError("STORY_MISMATCH", "Quest version changed while it was loading.");
        }

        const finalScene = input.kind === "completed" ? input.finalScene : null;
        const status = input.kind === "completed" ? "completed" : "active";
        const outcome = input.kind === "completed" ? "story_completed" : null;
        const updated = await executor.get(
          `UPDATE session
              SET status = ?,
                  ink_state_json = ?,
                  state_version = state_version + 1,
                  outcome = ?,
                  final_scene_text = ?,
                  final_scene_tags_json = ?
            WHERE id = ? AND owner_type = ? AND owner_id = ?
              AND status = 'created' AND state_version = ?
          RETURNING id`,
          status,
          input.inkState,
          outcome,
          finalScene?.text ?? null,
          finalScene === null ? null : JSON.stringify(finalScene.tags),
          input.sessionId,
          input.owner.type,
          input.owner.id,
          input.expectedStateVersion,
        );

        if (updated === undefined) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        if (input.kind === "active") {
          const turn = input.initialTurn.turn;
          await executor.run(
            `INSERT INTO turn (
               id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
               default_choice_index, vote_duration_ms, deadline_at_ms, remaining_ms,
               interactive_message_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
            turn.id,
            input.sessionId,
            turn.stepNumber,
            turn.inkCheckpoint,
            turn.sceneText,
            JSON.stringify(turn.choices),
            input.initialTurn.defaultChoiceIndex,
            input.initialTurn.voteDurationMs,
          );
        }

        return readSession(executor, input.owner, input.sessionId);
      });
    },
  };
}
