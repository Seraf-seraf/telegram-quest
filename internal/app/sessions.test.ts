import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type {
  FinalScene,
  QuestVersion,
  Session,
  SessionOwner,
  Turn,
} from "../domain/model.js";
import { InkStoryRuntime } from "../adapters/ink/runtime.js";
import {
  SessionError,
  type SessionStore,
  type SessionErrorCode,
  type ApplyDecisionRecord,
  type StartSessionRecord,
} from "./session-store.js";
import { SessionService } from "./sessions.js";
import { StorySourceError, type StorySource } from "./story-source.js";
import type { StoryRuntime, StoryStep } from "./story.js";

const compiledStoryJson = readFileSync(
  new URL("../adapters/ink/fixtures/demo.ink.json", import.meta.url),
  "utf8",
);
const storyHash = createHash("sha256")
  .update(compiledStoryJson.replace(/^\uFEFF/, ""))
  .digest("hex");

const groupOwner: SessionOwner = { type: "group", id: "-100123" };
const userOwner: SessionOwner = { type: "user", id: "7654321" };
const questVersion = {
  id: "quest-version-1",
  questId: "quest-1",
  version: "1.0.0",
  storyReference: "stories/demo.ink.json",
  storyHash,
};

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    stepNumber: 1,
    inkCheckpoint: "checkpoint-json",
    sceneText: "A scene.",
    choices: [{ index: 0, text: "Continue", tags: [] }],
    decision: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    questVersionId: questVersion.id,
    owner: userOwner,
    status: "created",
    inkState: null,
    stateVersion: 0,
    turns: [],
    outcome: null,
    finalScene: null,
    ...overrides,
  };
}

function makeActiveSession(owner: SessionOwner = userOwner): Session {
  const step = new InkStoryRuntime().start(compiledStoryJson);
  return makeSession({
    owner,
    status: "active",
    inkState: step.stateJson,
    stateVersion: 1,
    turns: [makeTurn({
      inkCheckpoint: step.stateJson,
      sceneText: step.text,
      choices: step.choices,
    })],
  });
}

function makeStore(options: {
  session?: Session;
  questAvailable?: boolean;
  questVersionExists?: boolean;
  processedOperationIds?: number[];
} = {}): SessionStore & {
  getQuestVersion: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listTurns: ReturnType<typeof vi.fn>;
  startSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  hasProcessedOperation: ReturnType<typeof vi.fn>;
  applyDecision: ReturnType<typeof vi.fn>;
} {
  let currentSession = options.session ?? makeSession();
  const processedOperationIds = new Set(options.processedOperationIds ?? []);
  const createSession = vi.fn(async (input) => makeSession({
    id: input.sessionId,
    owner: input.owner,
    questVersionId: input.questVersionId,
  }));
  const getQuestVersion = vi.fn(async (id: string) => {
    if (options.questVersionExists === false || id !== questVersion.id) {
      return null;
    }

    return {
      questVersion: { ...questVersion },
      questAvailable: options.questAvailable ?? true,
    };
  });
  const getSession = vi.fn(async (owner: SessionOwner, id: string) => {
    if (id !== currentSession.id) {
      throw new SessionError("NOT_FOUND", "Session was not found.");
    }

    if (owner.type !== currentSession.owner.type || owner.id !== currentSession.owner.id) {
      throw new SessionError("FORBIDDEN_OWNER", "Session belongs to another owner.");
    }

    return currentSession;
  });
  const listTurns = vi.fn(async (owner: SessionOwner, id: string) => {
    await getSession(owner, id);
    return [...currentSession.turns];
  });
  const startSession = vi.fn(async (input: StartSessionRecord) => {
    if (input.expectedStateVersion !== currentSession.stateVersion) {
      throw new SessionError("CONFLICT", "Session state changed.");
    }

    if (currentSession.status !== "created") {
      throw new SessionError("INVALID_TRANSITION", "Session cannot be started.");
    }

    const completed = input.kind === "completed";
    const turns = completed ? [] : [input.initialTurn.turn];
    const finalScene: FinalScene | null = completed ? input.finalScene : null;
    currentSession = {
      ...currentSession,
      status: completed ? "completed" : "active",
      inkState: input.inkState,
      stateVersion: currentSession.stateVersion + 1,
      turns,
      outcome: completed ? "story_completed" : null,
      finalScene,
    };
    return currentSession;
  });
  const hasProcessedOperation = vi.fn(async (operationId: number) =>
    processedOperationIds.has(operationId));
  const applyDecision = vi.fn(async (input: ApplyDecisionRecord) => {
    if (processedOperationIds.has(input.operationId)) {
      throw new SessionError("DUPLICATE_OPERATION", "Operation was already processed.");
    }

    if (currentSession.stateVersion !== input.expectedStateVersion) {
      throw new SessionError("CONFLICT", "Session state changed.");
    }

    if (currentSession.status !== "active") {
      throw new SessionError("INVALID_TRANSITION", "Session cannot accept a decision.");
    }

    const currentTurn = currentSession.turns.at(-1);
    if (currentTurn === undefined || currentTurn.id !== input.turnId) {
      throw new SessionError("INVALID_TRANSITION", "Turn is no longer current.");
    }

    if (!currentTurn.choices.some((choice) => choice.index === input.choiceIndex)) {
      throw new SessionError("INVALID_CHOICE", "Choice is not available.");
    }

    processedOperationIds.add(input.operationId);
    const decidedTurn = { ...currentTurn, decision: { choiceIndex: input.choiceIndex } };
    const turns = [
      ...currentSession.turns.slice(0, -1),
      decidedTurn,
      ...(input.result.kind === "active" ? [input.result.nextTurn.turn] : []),
    ];
    currentSession = {
      ...currentSession,
      status: input.result.kind === "completed" ? "completed" : "active",
      inkState: input.inkState,
      stateVersion: currentSession.stateVersion + 1,
      turns,
      outcome: input.result.kind === "completed" ? "story_completed" : null,
      finalScene: input.result.kind === "completed" ? input.result.finalScene : null,
    };
    return currentSession;
  });

  return {
    createSession,
    getQuestVersion,
    getSession,
    listTurns,
    startSession,
    hasProcessedOperation,
    applyDecision,
  };
}

function makeService(options: {
  store?: SessionStore;
  owner?: SessionOwner;
  questAvailable?: boolean;
  questVersionExists?: boolean;
  storyRuntime?: StoryRuntime;
  storySource?: StorySource;
  ids?: string[];
} = {}): {
  service: SessionService;
  store: ReturnType<typeof makeStore>;
  runtime: StoryRuntime;
  source: StorySource;
} {
  const store = (options.store as ReturnType<typeof makeStore> | undefined) ?? makeStore({
    session: makeSession({ owner: options.owner ?? userOwner }),
    questAvailable: options.questAvailable,
    questVersionExists: options.questVersionExists,
  });
  const runtime = options.storyRuntime ?? new InkStoryRuntime();
  const source = options.storySource ?? {
    load: vi.fn(async (version: QuestVersion) => {
      if (version.id !== questVersion.id || version.storyHash !== questVersion.storyHash) {
        throw new StorySourceError("NOT_FOUND", "Test story version was not found.");
      }

      return compiledStoryJson;
    }),
  };
  let nextId = 0;
  const ids = options.ids ?? ["new-session", "new-turn"];
  const service = new SessionService({
    store,
    storyRuntime: runtime,
    storySource: source,
    newId: () => ids[nextId++] ?? `id-${nextId}`,
    now: () => 1_700_000_000_000,
  });

  return { service, store, runtime, source };
}

async function expectSessionError(
  operation: Promise<unknown>,
  code: SessionErrorCode,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "SessionError",
    code,
  });
}

describe("SessionService", () => {
  it("creates a created session without an Ink state", async () => {
    const { service, store } = makeService();

    const session = await service.createSession(userOwner, questVersion.id, 501);

    expect(session).toMatchObject({
      id: "new-session",
      owner: userOwner,
      questVersionId: questVersion.id,
      status: "created",
      inkState: null,
      stateVersion: 0,
      turns: [],
      outcome: null,
      finalScene: null,
    });
    expect(store.createSession).toHaveBeenCalledWith({
      sessionId: "new-session",
      owner: userOwner,
      questVersionId: questVersion.id,
      operationId: 501,
      processedAtMs: 1_700_000_000_000,
    });
  });

  it("starts a personal session from its pinned version without timer fields", async () => {
    const runtime = new InkStoryRuntime();
    const choose = vi.spyOn(runtime, "choose");
    const load = vi.fn(async () => compiledStoryJson);
    const { service, store } = makeService({
      storyRuntime: runtime,
      storySource: { load },
    });

    const session = await service.startSession(userOwner, "session-1", 0);

    expect(session.status).toBe("active");
    expect(session.stateVersion).toBe(1);
    expect(session.inkState).toEqual(expect.any(String));
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({
      stepNumber: 1,
      sceneText: "A sign points toward two doors.\n",
      decision: null,
    });
    expect(store.startSession).toHaveBeenCalledWith(expect.objectContaining({
      kind: "active",
      sessionId: "session-1",
      questVersionId: questVersion.id,
      storyHash,
      expectedStateVersion: 0,
      initialTurn: expect.objectContaining({
        voteDurationMs: null,
        defaultChoiceIndex: null,
      }),
    }));
    expect(choose).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith(questVersion);
  });

  it("normalizes a leading BOM before checking the content hash and starting Ink", async () => {
    const { service, store } = makeService({
      storySource: {
        load: async () => `\uFEFF${compiledStoryJson.replace(/^\uFEFF/, "")}`,
      },
    });

    const session = await service.startSession(userOwner, "session-1", 0);

    expect(session.status).toBe("active");
    expect(store.startSession).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched version returned by the storage port before loading Ink", async () => {
    const store = makeStore();
    store.getQuestVersion.mockResolvedValue({
      questVersion: { ...questVersion, id: "another-version" },
      questAvailable: true,
    });
    const load = vi.fn(async () => compiledStoryJson);
    const runtime: StoryRuntime = {
      start: vi.fn(() => {
        throw new Error("Ink must not run for another version.");
      }),
      choose: vi.fn(),
    };
    const { service } = makeService({
      store,
      storyRuntime: runtime,
      storySource: { load },
    });

    await expectSessionError(
      service.startSession(userOwner, "session-1", 0),
      "STORY_MISMATCH",
    );

    expect(load).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("does not let StorySource mutate the pinned version hash to select other content", async () => {
    const alteredStoryJson = compiledStoryJson.replace("two doors", "three doors");
    const alteredStoryHash = createHash("sha256")
      .update(alteredStoryJson.replace(/^\uFEFF/, ""))
      .digest("hex");
    const store = makeStore();
    const runtime: StoryRuntime = {
      start: vi.fn(() => {
        throw new Error("Ink must not run for substituted content.");
      }),
      choose: vi.fn(),
    };
    const source: StorySource = {
      load: async (version) => {
        version.storyHash = alteredStoryHash;
        return alteredStoryJson;
      },
    };
    const { service } = makeService({ store, storyRuntime: runtime, storySource: source });

    await expectSessionError(
      service.startSession(userOwner, "session-1", 0),
      "STORY_MISMATCH",
    );

    expect(runtime.start).not.toHaveBeenCalled();
    expect(store.startSession).not.toHaveBeenCalled();
  });

  it("requires a valid group policy for an open group turn", async () => {
    const { service, store } = makeService({ owner: groupOwner });

    await expectSessionError(
      service.startSession(groupOwner, "session-1", 0),
      "INVALID_TRANSITION",
    );

    expect(store.startSession).not.toHaveBeenCalled();
  });

  it("persists the trusted group duration and selected default", async () => {
    const { service, store } = makeService({ owner: groupOwner });

    const session = await service.startSession(groupOwner, "session-1", 0, {
      voteDurationMs: 60_000,
      defaultChoiceIndex: 1,
    });

    expect(session.status).toBe("active");
    expect(store.startSession).toHaveBeenCalledWith(expect.objectContaining({
      kind: "active",
      initialTurn: expect.objectContaining({
        voteDurationMs: 60_000,
        defaultChoiceIndex: 1,
      }),
    }));
  });

  it("rejects invalid group duration and a default not present in the story", async () => {
    const invalidDuration = makeService({ owner: groupOwner });
    await expectSessionError(
      invalidDuration.service.startSession(groupOwner, "session-1", 0, {
        voteDurationMs: 0,
        defaultChoiceIndex: 0,
      }),
      "INVALID_TRANSITION",
    );

    const invalidDefault = makeService({ owner: groupOwner });
    await expectSessionError(
      invalidDefault.service.startSession(groupOwner, "session-1", 0, {
        voteDurationMs: 60_000,
        defaultChoiceIndex: 2,
      }),
      "INVALID_CHOICE",
    );
  });

  it("checks the stored content hash before executing Ink", async () => {
    const runtime = {
      start: vi.fn(() => {
        throw new Error("Ink must not run for mismatched content.");
      }),
      choose: vi.fn(),
    } satisfies StoryRuntime;
    const alteredSource: StorySource = {
      load: async () => compiledStoryJson.replace("two doors", "three doors"),
    };
    const { service, store } = makeService({
      storyRuntime: runtime,
      storySource: alteredSource,
    });

    await expectSessionError(
      service.startSession(userOwner, "session-1", 0),
      "STORY_MISMATCH",
    );
    expect(runtime.start).not.toHaveBeenCalled();
    expect(store.startSession).not.toHaveBeenCalled();
  });

  it("rejects a malformed Ink checkpoint before changing session state", async () => {
    const runtime: StoryRuntime = {
      start: vi.fn(() => ({
        text: "A scene.",
        choices: [{ index: 0, text: "Continue", tags: [] }],
        tags: [],
        stateJson: "not-json",
        ended: false,
      })),
      choose: vi.fn(),
    };
    const { service, store } = makeService({ storyRuntime: runtime });

    await expectSessionError(
      service.startSession(userOwner, "session-1", 0),
      "STORY_MISMATCH",
    );

    expect(store.startSession).not.toHaveBeenCalled();
  });

  it("rejects an unavailable or missing quest version before loading its story", async () => {
    const unavailable = makeService({ owner: userOwner, questAvailable: false });
    await expectSessionError(
      unavailable.service.startSession(userOwner, "session-1", 0),
      "INVALID_TRANSITION",
    );
    expect(unavailable.source.load).not.toHaveBeenCalled();

    const missing = makeService({ owner: userOwner, questVersionExists: false });
    await expectSessionError(
      missing.service.startSession(userOwner, "session-1", 0),
      "NOT_FOUND",
    );
    expect(missing.source.load).not.toHaveBeenCalled();
  });

  it("stores a terminal Ink result without creating an empty Turn", async () => {
    const terminalStep: StoryStep = {
      text: "The story ends immediately.",
      choices: [],
      tags: ["ending:instant", "mood:calm"],
      stateJson: "{\"terminal\":true}",
      ended: true,
    };
    const runtime: StoryRuntime = {
      start: vi.fn(() => terminalStep),
      choose: vi.fn(),
    };
    const { service, store } = makeService({
      owner: groupOwner,
      storyRuntime: runtime,
    });

    const session = await service.startSession(groupOwner, "session-1", 0);

    expect(session).toMatchObject({
      status: "completed",
      outcome: "story_completed",
      turns: [],
      finalScene: {
        text: terminalStep.text,
        tags: terminalStep.tags,
      },
    });
    expect(store.startSession).toHaveBeenCalledWith({
      kind: "completed",
      sessionId: "session-1",
      owner: groupOwner,
      questVersionId: questVersion.id,
      storyHash,
      expectedStateVersion: 0,
      inkState: "{\"terminal\":true}",
      finalScene: { text: terminalStep.text, tags: terminalStep.tags },
    });
  });

  it("does not run Ink when reading the session or its history", async () => {
    const openTurn = makeTurn();
    const store = makeStore({
      session: makeSession({
        owner: userOwner,
        status: "active",
        inkState: "saved-state",
        stateVersion: 1,
        turns: [openTurn],
      }),
    });
    const runtime = {
      start: vi.fn(() => {
        throw new Error("Unexpected Ink execution.");
      }),
      choose: vi.fn(() => {
        throw new Error("Unexpected Ink execution.");
      }),
    } satisfies StoryRuntime;
    const { service } = makeService({ store, storyRuntime: runtime });

    const session = await service.getSession(userOwner, "session-1");
    const turns = await service.listTurns(userOwner, "session-1");

    expect(session.inkState).toBe("saved-state");
    expect(session.turns).toEqual([openTurn]);
    expect(turns).toEqual([openTurn]);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.choose).not.toHaveBeenCalled();
  });

  it("applies a choice from the stored checkpoint and persists the next decision point", async () => {
    const initialSession = makeActiveSession();
    const store = makeStore({ session: initialSession });
    const runtime = new InkStoryRuntime();
    const choose = vi.spyOn(runtime, "choose");
    const { service } = makeService({
      store,
      storyRuntime: runtime,
      ids: ["next-turn"],
    });

    const session = await service.applyDecision(
      userOwner,
      initialSession.id,
      initialSession.turns[0]!.id,
      0,
      initialSession.stateVersion,
      601,
    );

    expect(choose).toHaveBeenCalledWith(
      compiledStoryJson.replace(/^\uFEFF/, ""),
      initialSession.turns[0]!.inkCheckpoint,
      0,
    );
    expect(session).toMatchObject({
      status: "active",
      stateVersion: 2,
      turns: [
        { id: initialSession.turns[0]!.id, decision: { choiceIndex: 0 } },
        { id: "next-turn", stepNumber: 2, decision: null },
      ],
    });
    expect(store.applyDecision).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 601,
      expectedStateVersion: 1,
      turnId: initialSession.turns[0]!.id,
      choiceIndex: 0,
      inkState: session.inkState,
      result: expect.objectContaining({ kind: "active" }),
    }));
  });

  it("requires and persists a trusted policy for the next open group turn", async () => {
    const initialSession = makeActiveSession(groupOwner);
    const withoutPolicyStore = makeStore({ session: initialSession });
    const withoutPolicy = makeService({ store: withoutPolicyStore, owner: groupOwner });

    await expectSessionError(
      withoutPolicy.service.applyDecision(
        groupOwner,
        initialSession.id,
        initialSession.turns[0]!.id,
        0,
        initialSession.stateVersion,
        607,
      ),
      "INVALID_TRANSITION",
    );
    expect(withoutPolicyStore.applyDecision).not.toHaveBeenCalled();

    const withPolicyStore = makeStore({ session: initialSession });
    const withPolicy = makeService({ store: withPolicyStore, owner: groupOwner });
    await withPolicy.service.applyDecision(
      groupOwner,
      initialSession.id,
      initialSession.turns[0]!.id,
      0,
      initialSession.stateVersion,
      608,
      { voteDurationMs: 45_000, defaultChoiceIndex: 1 },
    );

    expect(withPolicyStore.applyDecision).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        kind: "active",
        nextTurn: expect.objectContaining({
          voteDurationMs: 45_000,
          defaultChoiceIndex: 1,
        }),
      }),
    }));
  });

  it("rejects stale turns, unavailable choices and corrupt checkpoints before executing Ink", async () => {
    const staleTurnSession = makeActiveSession();
    const staleRuntime = new InkStoryRuntime();
    const staleChoose = vi.spyOn(staleRuntime, "choose");
    const stale = makeService({
      store: makeStore({ session: staleTurnSession }),
      storyRuntime: staleRuntime,
    });
    await expectSessionError(
      stale.service.applyDecision(
        userOwner,
        staleTurnSession.id,
        "old-turn",
        0,
        staleTurnSession.stateVersion,
        602,
      ),
      "INVALID_TRANSITION",
    );

    const choiceSession = makeActiveSession();
    const choiceRuntime = new InkStoryRuntime();
    const choiceChoose = vi.spyOn(choiceRuntime, "choose");
    const invalidChoice = makeService({
      store: makeStore({ session: choiceSession }),
      storyRuntime: choiceRuntime,
    });
    await expectSessionError(
      invalidChoice.service.applyDecision(
        userOwner,
        choiceSession.id,
        choiceSession.turns[0]!.id,
        2,
        choiceSession.stateVersion,
        603,
      ),
      "INVALID_CHOICE",
    );

    const corruptSession = makeActiveSession();
    corruptSession.turns[0]!.inkCheckpoint = "{}";
    const corruptRuntime = new InkStoryRuntime();
    const corruptChoose = vi.spyOn(corruptRuntime, "choose");
    const corrupt = makeService({
      store: makeStore({ session: corruptSession }),
      storyRuntime: corruptRuntime,
    });
    await expectSessionError(
      corrupt.service.applyDecision(
        userOwner,
        corruptSession.id,
        corruptSession.turns[0]!.id,
        0,
        corruptSession.stateVersion,
        604,
      ),
      "STORY_MISMATCH",
    );

    expect(staleChoose).not.toHaveBeenCalled();
    expect(choiceChoose).not.toHaveBeenCalled();
    expect(corruptChoose).not.toHaveBeenCalled();
  });

  it("reads an already processed operation before rerunning Ink", async () => {
    const session = makeActiveSession();
    const store = makeStore({ session, processedOperationIds: [605] });
    const runtime = new InkStoryRuntime();
    const choose = vi.spyOn(runtime, "choose");
    const { service } = makeService({ store, storyRuntime: runtime });

    await expectSessionError(
      service.applyDecision(
        userOwner,
        session.id,
        session.turns[0]!.id,
        0,
        session.stateVersion,
        605,
      ),
      "DUPLICATE_OPERATION",
    );

    expect(store.hasProcessedOperation).toHaveBeenCalledWith(605);
    expect(choose).not.toHaveBeenCalled();
  });

  it("stores the final Ink scene and tags after a decision ends the story", async () => {
    const runtime = new InkStoryRuntime();
    const firstStep = runtime.start(compiledStoryJson);
    const secondStep = runtime.choose(compiledStoryJson, firstStep.stateJson, 0);
    const session = makeSession({
      status: "active",
      inkState: secondStep.stateJson,
      stateVersion: 2,
      turns: [makeTurn({
        id: "turn-2",
        stepNumber: 2,
        inkCheckpoint: secondStep.stateJson,
        sceneText: secondStep.text,
        choices: secondStep.choices,
      })],
    });
    const store = makeStore({ session });
    const { service } = makeService({ store, storyRuntime: runtime });

    const completed = await service.applyDecision(
      userOwner,
      session.id,
      "turn-2",
      0,
      session.stateVersion,
      606,
    );

    expect(completed).toMatchObject({
      status: "completed",
      stateVersion: 3,
      outcome: "story_completed",
      finalScene: { text: "The left road leads home.\n", tags: ["ending:left"] },
      turns: [{ id: "turn-2", decision: { choiceIndex: 0 } }],
    });
  });

  it("keeps owner, transition and expected-state failures distinct", async () => {
    const forbidden = makeService({
      store: makeStore({ session: makeSession({ owner: groupOwner }) }),
    });
    await expectSessionError(
      forbidden.service.startSession(userOwner, "session-1", 0),
      "FORBIDDEN_OWNER",
    );

    const stale = makeService({
      store: makeStore({ session: makeSession({ stateVersion: 1 }) }),
    });
    await expectSessionError(
      stale.service.startSession(userOwner, "session-1", 0),
      "CONFLICT",
    );

    const alreadyStarted = makeService({
      store: makeStore({ session: makeSession({ status: "active", stateVersion: 1 }) }),
    });
    await expectSessionError(
      alreadyStarted.service.startSession(userOwner, "session-1", 1),
      "INVALID_TRANSITION",
    );
  });

  it("maps story-source failures without leaking their details", async () => {
    const source: StorySource = {
      load: async () => {
        throw new StorySourceError("STORAGE_FAILURE", "private storage detail");
      },
    };
    const { service } = makeService({ storySource: source });

    await expectSessionError(
      service.startSession(userOwner, "session-1", 0),
      "STORAGE_FAILURE",
    );
  });
});
