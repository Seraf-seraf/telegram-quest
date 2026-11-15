import type {
  Choice,
  FinalScene,
  Outcome,
  Quest,
  Session,
  SessionOwner,
  SessionStatus,
  Turn,
} from "../../domain/model.js";
import {
  SessionError,
  type ApplyDecisionRecord,
  type CreateSessionRecord,
  type PauseSessionRecord,
  type RewindSessionRecord,
  type ResumeSessionRecord,
  type OwnedSessionPage,
  type OwnedSessionSummary,
  type SessionQuest,
  type SessionStore,
  type SessionTransitionRecord,
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
    questId: readString(row, "quest_id"),
    owner: readOwner(row),
    status: readStatus(row),
    inkState: readNullableString(row, "ink_state_json"),
    stateVersion: readInteger(row, "state_version"),
    turns,
    outcome,
    finalScene,
  };
}

function mapOwnedSessionSummary(row: SqlRow): OwnedSessionSummary {
  return {
    id: readString(row, "id"),
    questId: readString(row, "quest_id"),
    questTitle: readString(row, "quest_title"),
    status: readStatus(row),
    stateVersion: readInteger(row, "state_version"),
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

function readQuestAvailability(row: SqlRow): boolean {
  const available = readInteger(row, "available");
  if (available !== 0 && available !== 1) {
    throw invalidStorageData("quest availability");
  }
  return available === 1;
}

async function readQuest(
  executor: SqlExecutor,
  questId: string,
): Promise<SessionQuest | null> {
  const row = await executor.get(
    "SELECT id, title, description, genre, available FROM quest WHERE id = ?",
    questId,
  );

  if (row === undefined) {
    return null;
  }

  const quest: Quest = {
    id: readString(row, "id"),
    title: readString(row, "title"),
    description: readString(row, "description"),
    genre: readString(row, "genre"),
    available: readQuestAvailability(row),
  };
  return { quest, questAvailable: quest.available };
}

async function readSessionRow(
  executor: SqlExecutor,
  sessionId: string,
): Promise<SqlRow | undefined> {
  return executor.get(
    `SELECT id, quest_id, owner_type, owner_id, status, ink_state_json,
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
    `SELECT session.id, session.quest_id, session.owner_type, session.owner_id,
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
        AND session.status IN ('active', 'paused')
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

function assertQuestAvailable(details: SessionQuest | null): SessionQuest {
  if (details === null) {
    throw new SessionError("NOT_FOUND", "Quest was not found.");
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
    input.questId.length === 0 ||
    input.questId.trim() !== input.questId
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
    input.questId.length === 0 ||
    input.questId.trim() !== input.questId ||
    typeof input.finalScene.text !== "string" ||
    !Array.isArray(input.finalScene.tags) ||
    input.finalScene.tags.some((tag) => typeof tag !== "string")
  ) {
    throw new SessionError("INVALID_TRANSITION", "Completed session output is invalid.");
  }
}

function validateDecision(input: ApplyDecisionRecord): void {
  if (
    !Number.isSafeInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 0 ||
    !Number.isSafeInteger(input.choiceIndex) ||
    input.choiceIndex < 0 ||
    !Number.isSafeInteger(input.operationId) ||
    input.operationId < 0 ||
    !Number.isSafeInteger(input.processedAtMs) ||
    input.processedAtMs < 0 ||
    input.sessionId.length === 0 ||
    input.turnId.length === 0 ||
    input.questId.length === 0 ||
    input.questId.trim() !== input.questId ||
    !isJsonObject(input.inkState)
  ) {
    throw new SessionError("INVALID_TRANSITION", "Decision record is invalid.");
  }

  if (input.result.kind === "active") {
    const { turn } = input.result.nextTurn;
    if (
      turn.id.length === 0 ||
      !Number.isSafeInteger(turn.stepNumber) ||
      turn.stepNumber < 2 ||
      turn.decision !== null ||
      !isJsonObject(turn.inkCheckpoint) ||
      turn.inkCheckpoint !== input.inkState ||
      typeof turn.sceneText !== "string" ||
      turn.choices.length === 0 ||
      turn.choices.some((choice) =>
        !Number.isSafeInteger(choice.index) ||
        choice.index < 0 ||
        choice.index >= turn.choices.length ||
        typeof choice.text !== "string" ||
        !Array.isArray(choice.tags) ||
        choice.tags.some((tag) => typeof tag !== "string")
      )
    ) {
      throw new SessionError("INVALID_TRANSITION", "Next decision turn is invalid.");
    }

    if (input.owner.type === "group") {
      const { voteDurationMs, defaultChoiceIndex } = input.result.nextTurn;
      if (
        voteDurationMs === null ||
        !Number.isSafeInteger(voteDurationMs) ||
        voteDurationMs <= 0 ||
        defaultChoiceIndex === null ||
        !Number.isSafeInteger(defaultChoiceIndex) ||
        !turn.choices.some((choice) => choice.index === defaultChoiceIndex)
      ) {
        throw new SessionError("INVALID_TRANSITION", "Group turn policy is invalid.");
      }
    } else if (
      input.result.nextTurn.voteDurationMs !== null ||
      input.result.nextTurn.defaultChoiceIndex !== null
    ) {
      throw new SessionError("INVALID_TRANSITION", "Personal turns cannot have a vote policy.");
    }
  } else if (
    !isJsonObject(input.inkState) ||
    typeof input.result.finalScene.text !== "string" ||
    !Array.isArray(input.result.finalScene.tags) ||
    input.result.finalScene.tags.some((tag) => typeof tag !== "string")
  ) {
    throw new SessionError("INVALID_TRANSITION", "Final story output is invalid.");
  }
}

interface TurnTimerState {
  voteDurationMs: number | null;
  deadlineAtMs: number | null;
  remainingMs: number | null;
}

async function readTurnTimerState(
  executor: SqlExecutor,
  sessionId: string,
  turnId: string,
): Promise<TurnTimerState> {
  const row = await executor.get(
    `SELECT vote_duration_ms, deadline_at_ms, remaining_ms
       FROM turn
      WHERE id = ? AND session_id = ? AND decision_choice_index IS NULL`,
    turnId,
    sessionId,
  );
  if (row === undefined) {
    throw new SessionError("INVALID_TRANSITION", "Current turn is no longer open.");
  }

  const timer = {
    voteDurationMs: readNullableInteger(row, "vote_duration_ms"),
    deadlineAtMs: readNullableInteger(row, "deadline_at_ms"),
    remainingMs: readNullableInteger(row, "remaining_ms"),
  };
  if (
    (timer.deadlineAtMs !== null && timer.remainingMs !== null) ||
    ((timer.deadlineAtMs !== null || timer.remainingMs !== null) &&
      timer.voteDurationMs === null)
  ) {
    throw invalidStorageData("turn timer");
  }
  return timer;
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
    async getQuest(questId: string): Promise<SessionQuest | null> {
      return inRead((executor) => readQuest(executor, questId));
    },

    async createSession(input: CreateSessionRecord): Promise<Session> {
      return inWrite(async (executor) => {
        const details = assertQuestAvailable(
          await readQuest(executor, input.questId),
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
            `INSERT INTO session (id, quest_id, owner_type, owner_id)
             VALUES (?, ?, ?, ?)`,
            input.sessionId,
            details.quest.id,
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

    async listOwnedSessions(
      owner: SessionOwner,
      limit: number,
      cursor: string | null,
    ): Promise<OwnedSessionPage> {
      return inRead(async (executor) => {
        const rows = await executor.all(
          `SELECT session.id, session.quest_id, session.status,
                  session.state_version, quest.title AS quest_title
             FROM session
             JOIN quest ON quest.id = session.quest_id
            WHERE session.owner_type = ? AND session.owner_id = ?
              AND (? IS NULL OR session.id COLLATE BINARY > ?)
            ORDER BY session.id COLLATE BINARY ASC
            LIMIT ?`,
          owner.type,
          owner.id,
          cursor,
          cursor,
          limit + 1,
        );
        const sessions = rows.slice(0, limit).map(mapOwnedSessionSummary);
        const hasNextPage = rows.length > limit;

        return {
          sessions,
          nextCursor: hasNextPage ? sessions.at(-1)?.id ?? null : null,
        };
      });
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

        if (readString(row, "quest_id") !== input.questId) {
          throw new SessionError("STORY_MISMATCH", "Session is linked to another quest.");
        }

        assertQuestAvailable(await readQuest(executor, input.questId));

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

    async hasProcessedOperation(operationId: number): Promise<boolean> {
      if (!Number.isSafeInteger(operationId) || operationId < 0) {
        throw new SessionError("INVALID_TRANSITION", "Operation ID is invalid.");
      }

      return inRead(async (executor) => (await executor.get(
        "SELECT update_id FROM processed_update WHERE update_id = ?",
        operationId,
      )) !== undefined);
    },

    async applyDecision(input: ApplyDecisionRecord): Promise<Session> {
      validateDecision(input);

      return inWrite(async (executor) => {
        const sessionRow = await requireOwnedSession(executor, input.owner, input.sessionId);
        const processed = await executor.get(
          "SELECT update_id FROM processed_update WHERE update_id = ?",
          input.operationId,
        );
        if (processed !== undefined) {
          throw new SessionError("DUPLICATE_OPERATION", "Operation was already processed.");
        }

        if (readInteger(sessionRow, "state_version") !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        if (readStatus(sessionRow) !== "active") {
          throw new SessionError("INVALID_TRANSITION", "Session cannot accept a decision.");
        }

        if (readString(sessionRow, "quest_id") !== input.questId) {
          throw new SessionError("STORY_MISMATCH", "Session is linked to another quest.");
        }

        const latestQuest = await readQuest(executor, input.questId);
        if (latestQuest === null) {
          throw new SessionError("NOT_FOUND", "Quest was not found.");
        }

        const currentSession = await readSession(executor, input.owner, input.sessionId);
        const currentTurn = currentSession.turns[0];
        if (currentTurn === undefined || currentTurn.id !== input.turnId) {
          throw new SessionError("INVALID_TRANSITION", "Turn is no longer current.");
        }
        if (currentTurn.decision !== null) {
          throw new SessionError("INVALID_TRANSITION", "Turn already has a decision.");
        }
        if (
          currentSession.inkState === null ||
          currentSession.inkState !== currentTurn.inkCheckpoint
        ) {
          throw new SessionError("STORY_MISMATCH", "Saved Ink state does not match the current turn.");
        }
        if (!currentTurn.choices.some((choice) => choice.index === input.choiceIndex)) {
          throw new SessionError("INVALID_CHOICE", "Choice is not available.");
        }

        if (
          input.result.kind === "active" &&
          input.result.nextTurn.turn.stepNumber !== currentTurn.stepNumber + 1
        ) {
          throw new SessionError("STORY_MISMATCH", "Next turn number does not follow the current turn.");
        }

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

        const decidedTurn = await executor.get(
          `UPDATE turn
              SET decision_choice_index = ?
            WHERE id = ? AND session_id = ? AND decision_choice_index IS NULL
          RETURNING id`,
          input.choiceIndex,
          input.turnId,
          input.sessionId,
        );
        if (decidedTurn === undefined) {
          throw new SessionError("INVALID_TRANSITION", "Turn is no longer current.");
        }

        const completed = input.result.kind === "completed";
        const finalScene = input.result.kind === "completed" ? input.result.finalScene : null;
        const updated = await executor.get(
          `UPDATE session
              SET status = ?,
                  ink_state_json = ?,
                  state_version = state_version + 1,
                  outcome = ?,
                  final_scene_text = ?,
                  final_scene_tags_json = ?
            WHERE id = ? AND owner_type = ? AND owner_id = ?
              AND status = 'active' AND state_version = ?
              AND ink_state_json = ?
          RETURNING id`,
          completed ? "completed" : "active",
          input.inkState,
          completed ? "story_completed" : null,
          finalScene?.text ?? null,
          finalScene === null ? null : JSON.stringify(finalScene.tags),
          input.sessionId,
          input.owner.type,
          input.owner.id,
          input.expectedStateVersion,
          currentTurn.inkCheckpoint,
        );
        if (updated === undefined) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        if (input.result.kind === "active") {
          const turn = input.result.nextTurn.turn;
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
            input.result.nextTurn.defaultChoiceIndex,
            input.result.nextTurn.voteDurationMs,
          );
        }

        return readSession(executor, input.owner, input.sessionId);
      });
    },

    async pauseSession(input: PauseSessionRecord): Promise<Session> {
      if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
        throw new SessionError("INVALID_TRANSITION", "Current time is invalid.");
      }

      return inWrite(async (executor) => {
        const sessionRow = await requireOwnedSession(executor, input.owner, input.sessionId);
        if (readInteger(sessionRow, "state_version") !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }
        if (readStatus(sessionRow) !== "active") {
          throw new SessionError("INVALID_TRANSITION", "Only an active session can be paused.");
        }

        const session = await readSession(executor, input.owner, input.sessionId);
        const currentTurn = session.turns[0];
        if (currentTurn === undefined) {
          throw invalidStorageData("active session turn");
        }
        const timer = await readTurnTimerState(executor, input.sessionId, currentTurn.id);
        if (timer.remainingMs !== null) {
          throw invalidStorageData("active turn timer");
        }

        const remainingMs = timer.deadlineAtMs === null
          ? null
          : Math.max(timer.deadlineAtMs - input.nowMs, 0);
        if (remainingMs !== null && !Number.isSafeInteger(remainingMs)) {
          throw new SessionError("INVALID_TRANSITION", "Remaining vote duration is invalid.");
        }

        const updatedTurn = await executor.get(
          `UPDATE turn
              SET deadline_at_ms = NULL, remaining_ms = ?
            WHERE id = ? AND session_id = ? AND decision_choice_index IS NULL
          RETURNING id`,
          remainingMs,
          currentTurn.id,
          input.sessionId,
        );
        if (updatedTurn === undefined) {
          throw new SessionError("INVALID_TRANSITION", "Current turn is no longer open.");
        }

        const updatedSession = await executor.get(
          `UPDATE session
              SET status = 'paused', state_version = state_version + 1
            WHERE id = ? AND owner_type = ? AND owner_id = ?
              AND status = 'active' AND state_version = ?
          RETURNING id`,
          input.sessionId,
          input.owner.type,
          input.owner.id,
          input.expectedStateVersion,
        );
        if (updatedSession === undefined) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        return readSession(executor, input.owner, input.sessionId);
      });
    },

    async resumeSession(input: ResumeSessionRecord): Promise<Session> {
      if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
        throw new SessionError("INVALID_TRANSITION", "Current time is invalid.");
      }

      return inWrite(async (executor) => {
        const sessionRow = await requireOwnedSession(executor, input.owner, input.sessionId);
        if (readInteger(sessionRow, "state_version") !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }
        if (readStatus(sessionRow) !== "paused") {
          throw new SessionError("INVALID_TRANSITION", "Only a paused session can be resumed.");
        }

        const session = await readSession(executor, input.owner, input.sessionId);
        const currentTurn = session.turns[0];
        if (currentTurn === undefined) {
          throw invalidStorageData("paused session turn");
        }
        const timer = await readTurnTimerState(executor, input.sessionId, currentTurn.id);
        if (timer.deadlineAtMs !== null) {
          throw invalidStorageData("paused turn timer");
        }

        const deadlineAtMs = timer.remainingMs === null
          ? null
          : input.nowMs + timer.remainingMs;
        if (deadlineAtMs !== null && !Number.isSafeInteger(deadlineAtMs)) {
          throw new SessionError("INVALID_TRANSITION", "Resumed vote deadline is invalid.");
        }

        const updatedTurn = await executor.get(
          `UPDATE turn
              SET deadline_at_ms = ?, remaining_ms = NULL
            WHERE id = ? AND session_id = ? AND decision_choice_index IS NULL
          RETURNING id`,
          deadlineAtMs,
          currentTurn.id,
          input.sessionId,
        );
        if (updatedTurn === undefined) {
          throw new SessionError("INVALID_TRANSITION", "Current turn is no longer open.");
        }

        const updatedSession = await executor.get(
          `UPDATE session
              SET status = 'active', state_version = state_version + 1
            WHERE id = ? AND owner_type = ? AND owner_id = ?
              AND status = 'paused' AND state_version = ?
          RETURNING id`,
          input.sessionId,
          input.owner.type,
          input.owner.id,
          input.expectedStateVersion,
        );
        if (updatedSession === undefined) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        return readSession(executor, input.owner, input.sessionId);
      });
    },

    async stopSession(input: SessionTransitionRecord): Promise<Session> {
      return inWrite(async (executor) => {
        const sessionRow = await requireOwnedSession(executor, input.owner, input.sessionId);
        if (readInteger(sessionRow, "state_version") !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }
        const status = readStatus(sessionRow);
        if (status !== "created" && status !== "active" && status !== "paused") {
          throw new SessionError("INVALID_TRANSITION", "Session cannot be stopped.");
        }

        if (status === "active" || status === "paused") {
          const session = await readSession(executor, input.owner, input.sessionId);
          const currentTurn = session.turns[0];
          if (currentTurn === undefined) {
            throw invalidStorageData("open session turn");
          }
          const updatedTurn = await executor.get(
            `UPDATE turn
                SET deadline_at_ms = NULL, remaining_ms = NULL
              WHERE id = ? AND session_id = ? AND decision_choice_index IS NULL
            RETURNING id`,
            currentTurn.id,
            input.sessionId,
          );
          if (updatedTurn === undefined) {
            throw new SessionError("INVALID_TRANSITION", "Current turn is no longer open.");
          }
        }

        const updatedSession = await executor.get(
          `UPDATE session
              SET status = 'completed',
                  state_version = state_version + 1,
                  outcome = 'stopped_by_owner',
                  final_scene_text = NULL,
                  final_scene_tags_json = NULL
            WHERE id = ? AND owner_type = ? AND owner_id = ?
              AND status = ? AND state_version = ?
          RETURNING id`,
          input.sessionId,
          input.owner.type,
          input.owner.id,
          status,
          input.expectedStateVersion,
        );
        if (updatedSession === undefined) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        return readSession(executor, input.owner, input.sessionId);
      });
    },

    async restartSession(input: StartSessionRecord): Promise<Session> {
      if (input.kind === "active") {
        validateActiveStart(input);
      } else {
        validateCompletedStart(input);
      }

      return inWrite(async (executor) => {
        const sessionRow = await requireOwnedSession(executor, input.owner, input.sessionId);
        if (readInteger(sessionRow, "state_version") !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }
        if (readString(sessionRow, "quest_id") !== input.questId) {
          throw new SessionError("STORY_MISMATCH", "Session is linked to another quest.");
        }

        assertQuestAvailable(await readQuest(executor, input.questId));

        if (input.kind === "active") {
          const oldTurn = await executor.get(
            "SELECT id FROM turn WHERE session_id = ? AND id = ?",
            input.sessionId,
            input.initialTurn.turn.id,
          );
          if (oldTurn !== undefined) {
            throw new SessionError("INVALID_TRANSITION", "Restart must use a fresh turn ID.");
          }
        }

        await executor.run("DELETE FROM turn WHERE session_id = ?", input.sessionId);
        const completed = input.kind === "completed";
        const finalScene = completed ? input.finalScene : null;
        let updated: SqlRow | undefined;
        try {
          updated = await executor.get(
            `UPDATE session
                SET status = ?,
                    ink_state_json = ?,
                    state_version = state_version + 1,
                    outcome = ?,
                    final_scene_text = ?,
                    final_scene_tags_json = ?
              WHERE id = ? AND owner_type = ? AND owner_id = ?
                AND quest_id = ? AND state_version = ?
            RETURNING id`,
            completed ? "completed" : "active",
            input.inkState,
            completed ? "story_completed" : null,
            finalScene?.text ?? null,
            finalScene === null ? null : JSON.stringify(finalScene.tags),
            input.sessionId,
            input.owner.type,
            input.owner.id,
            input.questId,
            input.expectedStateVersion,
          );
        } catch (error) {
          if (isConstraintViolation(error)) {
            throw new SessionError("CONFLICT", "Session could not be restarted for this owner.");
          }
          throw error;
        }
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

    async rewindSession(input: RewindSessionRecord): Promise<Session> {
      if (
        !Number.isSafeInteger(input.expectedStateVersion) ||
        input.expectedStateVersion < 0 ||
        !Number.isSafeInteger(input.targetStepNo) ||
        input.targetStepNo < 1 ||
        input.newTurnId.length === 0
      ) {
        throw new SessionError("INVALID_TRANSITION", "Rewind record is invalid.");
      }

      return inWrite(async (executor) => {
        const sessionRow = await requireOwnedSession(executor, input.owner, input.sessionId);
        if (readInteger(sessionRow, "state_version") !== input.expectedStateVersion) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }
        const status = readStatus(sessionRow);
        if (status !== "active" && status !== "paused") {
          throw new SessionError("INVALID_TRANSITION", "Only active or paused sessions can be rewound.");
        }

        const session = await readSession(executor, input.owner, input.sessionId);
        const targetRow = await executor.get(
          `SELECT id, step_no, ink_checkpoint_json, scene_text, choices_json,
                  decision_choice_index, default_choice_index, vote_duration_ms
             FROM turn
            WHERE session_id = ? AND step_no = ?`,
          input.sessionId,
          input.targetStepNo,
        );
        if (targetRow === undefined) {
          throw new SessionError("NOT_FOUND", "Turn was not found.");
        }
        const existingId = await executor.get(
          "SELECT id FROM turn WHERE id = ?",
          input.newTurnId,
        );
        if (existingId !== undefined) {
          throw new SessionError("INVALID_TRANSITION", "Rewind must use a fresh turn ID.");
        }

        const targetTurn = mapTurn(targetRow);
        const defaultChoiceIndex = readNullableInteger(targetRow, "default_choice_index");
        const voteDurationMs = readNullableInteger(targetRow, "vote_duration_ms");
        const replacement: Turn = {
          ...targetTurn,
          id: input.newTurnId,
          decision: null,
        };
        await executor.run(
          "DELETE FROM turn WHERE session_id = ? AND step_no >= ?",
          input.sessionId,
          input.targetStepNo,
        );

        const updatedSession = await executor.get(
          `UPDATE session
              SET ink_state_json = ?, state_version = state_version + 1
            WHERE id = ? AND owner_type = ? AND owner_id = ?
              AND status = ? AND state_version = ?
          RETURNING id`,
          targetTurn.inkCheckpoint,
          input.sessionId,
          input.owner.type,
          input.owner.id,
          status,
          input.expectedStateVersion,
        );
        if (updatedSession === undefined) {
          throw new SessionError("CONFLICT", "Session state changed.");
        }

        await executor.run(
          `INSERT INTO turn (
             id, session_id, step_no, ink_checkpoint_json, scene_text, choices_json,
             default_choice_index, vote_duration_ms, deadline_at_ms, remaining_ms,
             interactive_message_id, decision_choice_index
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
          replacement.id,
          input.sessionId,
          replacement.stepNumber,
          replacement.inkCheckpoint,
          replacement.sceneText,
          JSON.stringify(replacement.choices),
          defaultChoiceIndex,
          voteDurationMs,
        );

        return readSession(executor, input.owner, input.sessionId);
      });
    },
  };
}
