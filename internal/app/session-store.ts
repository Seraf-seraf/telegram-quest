import type {
  FinalScene,
  QuestVersion,
  Session,
  SessionOwner,
  SessionStatus,
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

export interface OwnedSessionSummary {
  id: string;
  questVersionId: string;
  questTitle: string;
  questVersion: string;
  status: SessionStatus;
  stateVersion: number;
}

export interface OwnedSessionPage {
  sessions: OwnedSessionSummary[];
  nextCursor: string | null;
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

export interface ActiveDecisionResult {
  kind: "active";
  nextTurn: InitialTurnRecord;
}

export interface CompletedDecisionResult {
  kind: "completed";
  finalScene: FinalScene;
}

export interface ApplyDecisionRecord {
  sessionId: string;
  owner: SessionOwner;
  questVersionId: string;
  storyHash: string;
  expectedStateVersion: number;
  turnId: string;
  choiceIndex: number;
  operationId: number;
  processedAtMs: number;
  inkState: string;
  result: ActiveDecisionResult | CompletedDecisionResult;
}

export interface SessionTransitionRecord {
  sessionId: string;
  owner: SessionOwner;
  expectedStateVersion: number;
}

export interface PauseSessionRecord extends SessionTransitionRecord {
  nowMs: number;
}

export interface ResumeSessionRecord extends SessionTransitionRecord {
  nowMs: number;
}

export interface RewindSessionRecord extends SessionTransitionRecord {
  targetStepNo: number;
  newTurnId: string;
}

export interface SessionStore {
  /** Atomically records the operation and inserts a created session. */
  createSession(input: CreateSessionRecord): Promise<Session>;
  getQuestVersion(questVersionId: string): Promise<SessionQuestVersion | null>;
  /** Returns the session and its single current open turn, without loading history. */
  getSession(owner: SessionOwner, sessionId: string): Promise<Session>;
  /** Returns a bounded, owner-filtered page of session metadata without loading turns. */
  listOwnedSessions(
    owner: SessionOwner,
    limit: number,
    cursor: string | null,
  ): Promise<OwnedSessionPage>;
  listTurns(owner: SessionOwner, sessionId: string): Promise<Turn[]>;
  /** Compares owner, pinned version and state version, then persists state and the first turn atomically. */
  startSession(input: StartSessionRecord): Promise<Session>;
  /** Checks the globally unique Telegram update ID before an ambiguous decision is retried. */
  hasProcessedOperation(operationId: number): Promise<boolean>;
  /** Rechecks the current turn and atomically records the decision, next state and operation ID. */
  applyDecision(input: ApplyDecisionRecord): Promise<Session>;
  /** Pauses the session and transfers an active timer deadline into remaining milliseconds. */
  pauseSession(input: PauseSessionRecord): Promise<Session>;
  /** Resumes the session and restores an unexpired timer deadline from remaining milliseconds. */
  resumeSession(input: ResumeSessionRecord): Promise<Session>;
  /** Completes the session with stopped_by_owner and stops any current timer. */
  stopSession(input: SessionTransitionRecord): Promise<Session>;
  /** Destructively replaces all prior turns with a new run on the same pinned quest version. */
  restartSession(input: StartSessionRecord): Promise<Session>;
  /** Replaces the target turn and later history with a fresh turn at its saved Ink checkpoint. */
  rewindSession(input: RewindSessionRecord): Promise<Session>;
}
