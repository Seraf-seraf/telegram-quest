import type {
  FinalScene,
  QuestVersion,
  Session,
  SessionOwner,
  Turn,
} from "../domain/model.js";

export type SessionErrorCode =
  | "CONFLICT"
  | "DUPLICATE_OPERATION"
  | "FORBIDDEN_OWNER"
  | "INVALID_CHOICE"
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "STORAGE_FAILURE"
  | "STORY_MISMATCH";

export class SessionError extends Error {
  public constructor(
    public readonly code: SessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}

export interface SessionQuestVersion {
  questVersion: QuestVersion;
  questAvailable: boolean;
}

export interface CreateSessionRecord {
  sessionId: string;
  owner: SessionOwner;
  questVersionId: string;
  operationId: number;
  processedAtMs: number;
}

export interface InitialTurnRecord {
  turn: Turn;
  voteDurationMs: number | null;
  defaultChoiceIndex: number | null;
}

export interface ActiveSessionStart {
  kind: "active";
  sessionId: string;
  owner: SessionOwner;
  questVersionId: string;
  storyHash: string;
  expectedStateVersion: number;
  inkState: string;
  initialTurn: InitialTurnRecord;
}

export interface CompletedSessionStart {
  kind: "completed";
  sessionId: string;
  owner: SessionOwner;
  questVersionId: string;
  storyHash: string;
  expectedStateVersion: number;
  inkState: string;
  finalScene: FinalScene;
}

export type StartSessionRecord = ActiveSessionStart | CompletedSessionStart;

export interface SessionStore {
  /** Atomically records the operation and inserts a created session. */
  createSession(input: CreateSessionRecord): Promise<Session>;
  getQuestVersion(questVersionId: string): Promise<SessionQuestVersion | null>;
  /** Returns the session and its single current open turn, without loading history. */
  getSession(owner: SessionOwner, sessionId: string): Promise<Session>;
  listTurns(owner: SessionOwner, sessionId: string): Promise<Turn[]>;
  /** Compares owner, pinned version and state version, then persists state and the first turn atomically. */
  startSession(input: StartSessionRecord): Promise<Session>;
}
