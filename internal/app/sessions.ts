import { createHash, randomUUID } from "node:crypto";
import type {
  Choice,
  Session,
  SessionOwner,
  Turn,
} from "../domain/model.js";
import {
  SessionError,
  type ApplyDecisionRecord,
  type InitialTurnRecord,
  type PauseSessionRecord,
  type ResumeSessionRecord,
  type RewindSessionRecord,
  type SessionTransitionRecord,
  type StartSessionRecord,
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

    const pinnedStory = await this.loadPinnedStory(session.questVersionId, true);

    let step: StoryStep;

    try {
      step = this.storyRuntime.start(pinnedStory.compiledStoryJson);
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
        storyHash: pinnedStory.storyHash,
        expectedStateVersion,
        inkState: step.stateJson,
        finalScene: { text: step.text, tags: [...step.tags] },
      });
    }

    const initialTurn = this.createInitialTurn(owner, step, groupPolicy);

    return this.store.startSession({
      kind: "active",
      sessionId,
      owner,
      questVersionId: session.questVersionId,
      storyHash: pinnedStory.storyHash,
      expectedStateVersion,
      inkState: step.stateJson,
      initialTurn,
    });
  }

  public async applyDecision(
    owner: SessionOwner,
    sessionId: string,
    turnId: string,
    choiceIndex: number,
    expectedStateVersion: number,
    operationId: number,
    groupPolicy?: GroupTurnPolicy,
  ): Promise<Session> {
    assertOwner(owner);
    assertNonNegativeSafeInteger(expectedStateVersion, "Expected state version");
    assertNonNegativeSafeInteger(operationId, "Operation ID");

    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.trim() !== sessionId ||
      typeof turnId !== "string" ||
      turnId.length === 0 ||
      turnId.trim() !== turnId
    ) {
      throw new SessionError("INVALID_TRANSITION", "Session or turn ID is invalid.");
    }

    if (!Number.isSafeInteger(choiceIndex) || choiceIndex < 0) {
      throw new SessionError("INVALID_CHOICE", "Choice is not available.");
    }

    const session = await this.store.getSession(owner, sessionId);

    if (await this.store.hasProcessedOperation(operationId)) {
      throw new SessionError("DUPLICATE_OPERATION", "Operation was already processed.");
    }

    if (session.stateVersion !== expectedStateVersion) {
      throw new SessionError("CONFLICT", "Session state changed.");
    }

    if (session.status !== "active") {
      throw new SessionError("INVALID_TRANSITION", "Session cannot accept a decision.");
    }

    if (session.turns.length !== 1) {
      throw new SessionError("STORY_MISMATCH", "Active session has no unique current turn.");
    }

    const currentTurn = session.turns[0]!;
    if (currentTurn.id !== turnId || currentTurn.decision !== null) {
      throw new SessionError("INVALID_TRANSITION", "Turn is no longer current.");
    }

    if (
      session.inkState === null ||
      !isJsonObject(session.inkState) ||
      !isJsonObject(currentTurn.inkCheckpoint) ||
      session.inkState !== currentTurn.inkCheckpoint
    ) {
      throw new SessionError("STORY_MISMATCH", "Saved Ink state does not match the current turn.");
    }

    if (!currentTurn.choices.some((choice) => choice.index === choiceIndex)) {
      throw new SessionError("INVALID_CHOICE", "Choice is not available.");
    }

    const pinnedStory = await this.loadPinnedStory(session.questVersionId, false);
    let step: StoryStep;

    try {
      step = this.storyRuntime.choose(
        pinnedStory.compiledStoryJson,
        currentTurn.inkCheckpoint,
        choiceIndex,
      );
    } catch (error) {
      if (error instanceof StoryRuntimeError && error.code === "INVALID_CHOICE") {
        throw new SessionError("INVALID_CHOICE", "Choice is not available.", { cause: error });
      }

      if (error instanceof StoryRuntimeError && error.code === "STORY_ENDED") {
        throw new SessionError("INVALID_TRANSITION", "Story has no current decision.", {
          cause: error,
        });
      }

      throw new SessionError("STORY_MISMATCH", "Saved story state could not be advanced.", {
        cause: error,
      });
    }

    assertStoryStep(step);

    if (!step.ended && step.choices.length === 0) {
      throw new SessionError("STORY_MISMATCH", "Story has no choice at its next decision point.");
    }

    const processedAtMs = this.now();
    assertNonNegativeSafeInteger(processedAtMs, "Current time");

    let result: ApplyDecisionRecord["result"];
    if (step.ended) {
      result = {
        kind: "completed",
        finalScene: { text: step.text, tags: [...step.tags] },
      };
    } else {
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

      if (!Number.isSafeInteger(currentTurn.stepNumber) || currentTurn.stepNumber < 1) {
        throw new SessionError("STORY_MISMATCH", "Current turn number is invalid.");
      }

      const stepNumber = currentTurn.stepNumber + 1;
      if (!Number.isSafeInteger(stepNumber)) {
        throw new SessionError("STORY_MISMATCH", "Next turn number is invalid.");
      }

      result = {
        kind: "active",
        nextTurn: {
          turn: {
            id: createId(this.newId, "Turn ID"),
            stepNumber,
            inkCheckpoint: step.stateJson,
            sceneText: step.text,
            choices: step.choices.map(cloneChoice),
            decision: null,
          },
          voteDurationMs,
          defaultChoiceIndex,
        },
      };
    }

    return this.store.applyDecision({
      sessionId,
      owner,
      questVersionId: session.questVersionId,
      storyHash: pinnedStory.storyHash,
      expectedStateVersion,
      turnId,
      choiceIndex,
      operationId,
      processedAtMs,
      inkState: step.stateJson,
      result,
    });
  }

  public async pauseSession(
    owner: SessionOwner,
    sessionId: string,
    expectedStateVersion: number,
  ): Promise<Session> {
    const session = await this.getExpectedSession(owner, sessionId, expectedStateVersion);
    if (session.status !== "active") {
      throw new SessionError("INVALID_TRANSITION", "Only an active session can be paused.");
    }

    const nowMs = this.now();
    assertNonNegativeSafeInteger(nowMs, "Current time");
    const input: PauseSessionRecord = { sessionId, owner, expectedStateVersion, nowMs };
    return this.store.pauseSession(input);
  }

  public async resumeSession(
    owner: SessionOwner,
    sessionId: string,
    expectedStateVersion: number,
  ): Promise<Session> {
    const session = await this.getExpectedSession(owner, sessionId, expectedStateVersion);
    if (session.status !== "paused") {
      throw new SessionError("INVALID_TRANSITION", "Only a paused session can be resumed.");
    }

    const nowMs = this.now();
    assertNonNegativeSafeInteger(nowMs, "Current time");
    const input: ResumeSessionRecord = { sessionId, owner, expectedStateVersion, nowMs };
    return this.store.resumeSession(input);
  }

  public async stopSession(
    owner: SessionOwner,
    sessionId: string,
    expectedStateVersion: number,
  ): Promise<Session> {
    const session = await this.getExpectedSession(owner, sessionId, expectedStateVersion);
    if (session.status === "completed") {
      throw new SessionError("INVALID_TRANSITION", "Completed session cannot be stopped.");
    }

    const input: SessionTransitionRecord = { sessionId, owner, expectedStateVersion };
    return this.store.stopSession(input);
  }

  public async restartSession(
    owner: SessionOwner,
    sessionId: string,
    expectedStateVersion: number,
    confirmed: boolean,
    groupPolicy?: GroupTurnPolicy,
  ): Promise<Session> {
    const session = await this.getExpectedSession(owner, sessionId, expectedStateVersion);
    if (confirmed !== true) {
      throw new SessionError("INVALID_TRANSITION", "Restart requires explicit confirmation.");
    }

    const pinnedStory = await this.loadPinnedStory(session.questVersionId, true);
    let step: StoryStep;
    try {
      step = this.storyRuntime.start(pinnedStory.compiledStoryJson);
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

    let input: StartSessionRecord;
    if (step.ended) {
      input = {
        kind: "completed",
        sessionId,
        owner,
        questVersionId: session.questVersionId,
        storyHash: pinnedStory.storyHash,
        expectedStateVersion,
        inkState: step.stateJson,
        finalScene: { text: step.text, tags: [...step.tags] },
      };
    } else {
      input = {
        kind: "active",
        sessionId,
        owner,
        questVersionId: session.questVersionId,
        storyHash: pinnedStory.storyHash,
        expectedStateVersion,
        inkState: step.stateJson,
        initialTurn: this.createInitialTurn(owner, step, groupPolicy),
      };
    }

    return this.store.restartSession(input);
  }

  public async rewindSession(
    owner: SessionOwner,
    sessionId: string,
    targetStepNo: number,
    expectedStateVersion: number,
  ): Promise<Session> {
    assertNonNegativeSafeInteger(expectedStateVersion, "Expected state version");
    if (!Number.isSafeInteger(targetStepNo) || targetStepNo < 1) {
      throw new SessionError("INVALID_TRANSITION", "Target turn number is invalid.");
    }

    const session = await this.getExpectedSession(owner, sessionId, expectedStateVersion);
    if (session.status !== "active" && session.status !== "paused") {
      throw new SessionError("INVALID_TRANSITION", "Only active or paused sessions can be rewound.");
    }

    const input: RewindSessionRecord = {
      sessionId,
      owner,
      expectedStateVersion,
      targetStepNo,
      newTurnId: createId(this.newId, "Turn ID"),
    };
    return this.store.rewindSession(input);
  }

  public getSession(owner: SessionOwner, sessionId: string): Promise<Session> {
    assertOwner(owner);
    return this.store.getSession(owner, sessionId);
  }

  public listTurns(owner: SessionOwner, sessionId: string): Promise<Turn[]> {
    assertOwner(owner);
    return this.store.listTurns(owner, sessionId);
  }

  private async getExpectedSession(
    owner: SessionOwner,
    sessionId: string,
    expectedStateVersion: number,
  ): Promise<Session> {
    assertOwner(owner);
    assertNonNegativeSafeInteger(expectedStateVersion, "Expected state version");
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.trim() !== sessionId
    ) {
      throw new SessionError("INVALID_TRANSITION", "Session ID is invalid.");
    }

    const session = await this.store.getSession(owner, sessionId);
    if (session.stateVersion !== expectedStateVersion) {
      throw new SessionError("CONFLICT", "Session state changed.");
    }
    return session;
  }

  private createInitialTurn(
    owner: SessionOwner,
    step: StoryStep,
    groupPolicy?: GroupTurnPolicy,
  ): InitialTurnRecord {
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

    return {
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
  }

  private async loadPinnedStory(
    questVersionId: string,
    requireAvailable: boolean,
  ): Promise<{ compiledStoryJson: string; storyHash: string }> {
    const versionDetails = await this.store.getQuestVersion(questVersionId);

    if (versionDetails === null) {
      throw new SessionError("NOT_FOUND", "Quest version was not found.");
    }

    if (versionDetails.questVersion.id !== questVersionId) {
      throw new SessionError("STORY_MISMATCH", "Session is pinned to another quest version.");
    }

    if (requireAvailable && !versionDetails.questAvailable) {
      throw new SessionError("INVALID_TRANSITION", "Quest is not available.");
    }

    const pinnedStoryHash = versionDetails.questVersion.storyHash;
    if (!/^[a-f\d]{64}$/i.test(pinnedStoryHash)) {
      throw new SessionError("STORY_MISMATCH", "Quest version has an invalid content hash.");
    }

    let compiledStoryJson: string;
    try {
      compiledStoryJson = await this.storySource.load({ ...versionDetails.questVersion });
    } catch (error) {
      if (error instanceof StorySourceError) {
        throw new SessionError(error.code, "Quest story could not be loaded.", { cause: error });
      }

      throw new SessionError("STORAGE_FAILURE", "Quest story could not be loaded.", {
        cause: error,
      });
    }

    if (typeof compiledStoryJson !== "string") {
      throw new SessionError("STORY_MISMATCH", "Quest story source returned invalid content.");
    }

    compiledStoryJson = compiledStoryJson.replace(/^\uFEFF/, "");
    const actualStoryHash = createHash("sha256").update(compiledStoryJson).digest("hex");
    if (actualStoryHash !== pinnedStoryHash.toLowerCase()) {
      throw new SessionError("STORY_MISMATCH", "Quest story does not match its stored version.");
    }

    return { compiledStoryJson, storyHash: pinnedStoryHash };
  }
}
