import { createHash, randomUUID } from "node:crypto";
import type {
  Choice,
  Session,
  SessionOwner,
  Turn,
} from "../domain/model.js";
import {
  SessionError,
  type SessionStore,
} from "./session-store.js";
import { StoryRuntimeError, type StoryRuntime, type StoryStep } from "./story.js";
import { StorySourceError, type StorySource } from "./story-source.js";

export interface GroupTurnPolicy {
  voteDurationMs: number;
  defaultChoiceIndex: number;
}

export interface SessionServiceDependencies {
  store: SessionStore;
  storyRuntime: StoryRuntime;
  storySource: StorySource;
  newId?: () => string;
  now?: () => number;
}

function assertOwner(owner: SessionOwner): void {
  if (
    typeof owner !== "object" ||
    owner === null ||
    (owner.type !== "group" && owner.type !== "user") ||
    typeof owner.id !== "string" ||
    owner.id.length === 0 ||
    owner.id.trim() !== owner.id
  ) {
    throw new SessionError("INVALID_TRANSITION", "Session owner is invalid.");
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionError("INVALID_TRANSITION", `${label} is invalid.`);
  }
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function assertStoryStep(step: unknown): asserts step is StoryStep {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new SessionError("STORY_MISMATCH", "Story runtime returned an invalid step.");
  }

  const candidate = step as Record<string, unknown>;
  if (
    typeof candidate.text !== "string" ||
    !Array.isArray(candidate.tags) ||
    candidate.tags.some((tag) => typeof tag !== "string") ||
    typeof candidate.stateJson !== "string" ||
    !isJsonObject(candidate.stateJson) ||
    typeof candidate.ended !== "boolean" ||
    !Array.isArray(candidate.choices)
  ) {
    throw new SessionError("STORY_MISMATCH", "Story runtime returned an invalid step.");
  }

  const choiceIndexes = new Set<number>();

  for (const choiceValue of candidate.choices) {
    if (typeof choiceValue !== "object" || choiceValue === null || Array.isArray(choiceValue)) {
      throw new SessionError("STORY_MISMATCH", "Story runtime returned an invalid choice.");
    }

    const choice = choiceValue as Record<string, unknown>;
    const choiceIndex = choice.index;
    if (
      typeof choiceIndex !== "number" ||
      !Number.isSafeInteger(choiceIndex) ||
      choiceIndex < 0 ||
      choiceIndex >= candidate.choices.length ||
      typeof choice.text !== "string" ||
      !Array.isArray(choice.tags) ||
      choice.tags.some((tag) => typeof tag !== "string") ||
      choiceIndexes.has(choiceIndex)
    ) {
      throw new SessionError("STORY_MISMATCH", "Story runtime returned an invalid choice.");
    }

    choiceIndexes.add(choiceIndex);
  }

  if (candidate.ended === (candidate.choices.length > 0)) {
    throw new SessionError("STORY_MISMATCH", "Story runtime returned inconsistent ending data.");
  }
}

function createId(newId: () => string, label: string): string {
  const id = newId();

  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    throw new SessionError("STORAGE_FAILURE", `${label} generation failed.`);
  }

  return id;
}

function cloneChoice(choice: Choice): Choice {
  return { index: choice.index, text: choice.text, tags: [...choice.tags] };
}

export class SessionService {
  private readonly store: SessionStore;
  private readonly storyRuntime: StoryRuntime;
  private readonly storySource: StorySource;
  private readonly newId: () => string;
  private readonly now: () => number;

  public constructor(dependencies: SessionServiceDependencies) {
    this.store = dependencies.store;
    this.storyRuntime = dependencies.storyRuntime;
    this.storySource = dependencies.storySource;
    this.newId = dependencies.newId ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
  }

  public async createSession(
    owner: SessionOwner,
    questVersionId: string,
    operationId: number,
  ): Promise<Session> {
    assertOwner(owner);

    if (
      typeof questVersionId !== "string" ||
      questVersionId.length === 0 ||
      questVersionId.trim() !== questVersionId
    ) {
      throw new SessionError("NOT_FOUND", "Quest version was not found.");
    }

    assertNonNegativeSafeInteger(operationId, "Operation ID");
    const sessionId = createId(this.newId, "Session ID");
    const processedAtMs = this.now();
    assertNonNegativeSafeInteger(processedAtMs, "Current time");
    return this.store.createSession({
      sessionId,
      owner,
      questVersionId,
      operationId,
      processedAtMs,
    });
  }

  public async startSession(
    owner: SessionOwner,
    sessionId: string,
    expectedStateVersion: number,
    groupPolicy?: GroupTurnPolicy,
  ): Promise<Session> {
    assertOwner(owner);
    assertNonNegativeSafeInteger(expectedStateVersion, "Expected state version");
    const session = await this.store.getSession(owner, sessionId);

    if (session.stateVersion !== expectedStateVersion) {
      throw new SessionError("CONFLICT", "Session state changed.");
    }

    if (session.status !== "created") {
      throw new SessionError("INVALID_TRANSITION", "Session cannot be started.");
    }

    const versionDetails = await this.store.getQuestVersion(session.questVersionId);

    if (versionDetails === null) {
      throw new SessionError("NOT_FOUND", "Quest version was not found.");
    }

    if (versionDetails.questVersion.id !== session.questVersionId) {
      throw new SessionError("STORY_MISMATCH", "Session is pinned to another quest version.");
    }

    if (!versionDetails.questAvailable) {
      throw new SessionError("INVALID_TRANSITION", "Quest is not available.");
    }

    const pinnedStoryHash = versionDetails.questVersion.storyHash;
    if (!/^[a-f\d]{64}$/i.test(pinnedStoryHash)) {
      throw new SessionError("STORY_MISMATCH", "Quest version has an invalid content hash.");
    }
    const sourceVersion = { ...versionDetails.questVersion };

    let compiledStoryJson: string;

    try {
      compiledStoryJson = await this.storySource.load(sourceVersion);
    } catch (error) {
      if (error instanceof StorySourceError) {
        throw new SessionError(error.code, "Quest story could not be loaded.", { cause: error });
      }

      throw new SessionError("STORAGE_FAILURE", "Quest story could not be loaded.", { cause: error });
    }

    if (typeof compiledStoryJson !== "string") {
      throw new SessionError("STORY_MISMATCH", "Quest story source returned invalid content.");
    }

    const normalizedStoryJson = compiledStoryJson.replace(/^\uFEFF/, "");
    const actualStoryHash = createHash("sha256").update(normalizedStoryJson).digest("hex");

    if (actualStoryHash !== pinnedStoryHash.toLowerCase()) {
      throw new SessionError("STORY_MISMATCH", "Quest story does not match its stored version.");
    }

    let step: StoryStep;

    try {
      step = this.storyRuntime.start(normalizedStoryJson);
    } catch (error) {
      const message = error instanceof StoryRuntimeError && error.code === "INVALID_STORY"
        ? "Quest story is not a valid compiled Ink story."
        : "Quest story could not be started.";
      throw new SessionError("STORY_MISMATCH", message, { cause: error });
    }

    assertStoryStep(step);

    if (!step.ended && step.choices.length === 0) {
      throw new SessionError("STORY_MISMATCH", "Story has no choice at its first decision point.");
    }

    if (step.ended) {
      return this.store.startSession({
        kind: "completed",
        sessionId,
        owner,
        questVersionId: session.questVersionId,
        storyHash: pinnedStoryHash,
        expectedStateVersion,
        inkState: step.stateJson,
        finalScene: { text: step.text, tags: [...step.tags] },
      });
    }

    let voteDurationMs: number | null = null;
    let defaultChoiceIndex: number | null = null;

    if (owner.type === "group") {
      if (groupPolicy === undefined) {
        throw new SessionError(
          "INVALID_TRANSITION",
          "A group turn requires a trusted vote policy.",
        );
      }

      if (!Number.isSafeInteger(groupPolicy.voteDurationMs) || groupPolicy.voteDurationMs <= 0) {
        throw new SessionError("INVALID_TRANSITION", "Group vote duration is invalid.");
      }

      if (
        !Number.isSafeInteger(groupPolicy.defaultChoiceIndex) ||
        groupPolicy.defaultChoiceIndex < 0 ||
        groupPolicy.defaultChoiceIndex >= step.choices.length ||
        !step.choices.some((choice) => choice.index === groupPolicy.defaultChoiceIndex)
      ) {
        throw new SessionError("INVALID_CHOICE", "Group default choice is not available.");
      }

      voteDurationMs = groupPolicy.voteDurationMs;
      defaultChoiceIndex = groupPolicy.defaultChoiceIndex;
    }

    const initialTurn = {
      turn: {
        id: createId(this.newId, "Turn ID"),
        stepNumber: 1,
        inkCheckpoint: step.stateJson,
        sceneText: step.text,
        choices: step.choices.map(cloneChoice),
        decision: null,
      },
      voteDurationMs,
      defaultChoiceIndex,
    };

    return this.store.startSession({
      kind: "active",
      sessionId,
      owner,
      questVersionId: session.questVersionId,
      storyHash: pinnedStoryHash,
      expectedStateVersion,
      inkState: step.stateJson,
      initialTurn,
    });
  }

  public getSession(owner: SessionOwner, sessionId: string): Promise<Session> {
    assertOwner(owner);
    return this.store.getSession(owner, sessionId);
  }

  public listTurns(owner: SessionOwner, sessionId: string): Promise<Turn[]> {
    assertOwner(owner);
    return this.store.listTurns(owner, sessionId);
  }
}
