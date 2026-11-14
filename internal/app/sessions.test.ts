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

function makeStore(options: {
  session?: Session;
  questAvailable?: boolean;
  questVersionExists?: boolean;
} = {}): SessionStore & {
  getQuestVersion: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listTurns: ReturnType<typeof vi.fn>;
  startSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
} {
  let currentSession = options.session ?? makeSession();
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

  return {
    createSession,
    getQuestVersion,
    getSession,
    listTurns,
    startSession,
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
