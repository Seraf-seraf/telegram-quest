import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  CallbackDataError,
  encodePrivateQuestCallback,
  parsePrivateQuestCallback,
  type PrivateQuestCallback,
} from "./callbacks.js";

describe("private quest callback protocol", () => {
  it("round-trips each navigation command and UTF-8 identifiers", () => {
    const callbacks: PrivateQuestCallback[] = [
      { kind: "menu" },
      { kind: "quests" },
      { kind: "quest", questId: "quest-две-двери" },
      { kind: "start", questId: "quest-две-двери" },
      { kind: "sessions" },
      { kind: "sessions_page", cursor: "session-cursor" },
      { kind: "genres_page", page: 2 },
      { kind: "genre", key: "abcdefghijk", genrePage: 2 },
      { kind: "quests_page", page: 3, genreKey: "abcdefghijk", genrePage: 2 },
      { kind: "quests_page", page: 1, genreKey: null, genrePage: 1 },
      { kind: "quest_card", questId: "q".repeat(32), catalogPage: 2176782335, genreKey: "abcdefghijk", genrePage: 2176782335 },
      { kind: "sessions_number_page", page: 3 },
      { kind: "history_page", sessionId: "b19c7550-3142-4a08-b0a5-3b18b9c40000", stateVersion: Number.MAX_SAFE_INTEGER, page: 3 },
      { kind: "history_target", sessionId: "b19c7550-3142-4a08-b0a5-3b18b9c40000", stateVersion: 4, targetStepNo: 12 },
      { kind: "noop" },
      { kind: "session", sessionId: "b19c7550-3142-4a08-b0a5-3b18b9c40000" },
      {
        kind: "choice",
        sessionId: "b19c7550-3142-4a08-b0a5-3b18b9c40000",
        stateVersion: 123,
        choiceIndex: 11,
      },
      { kind: "manage", sessionId: "session-1", stateVersion: 12 },
      { kind: "pause", sessionId: "session-1", stateVersion: 12 },
      { kind: "resume", sessionId: "session-1", stateVersion: 12 },
      { kind: "stop_prompt", sessionId: "session-1", stateVersion: 12 },
      { kind: "stop_confirm", sessionId: "session-1", stateVersion: 12, confirmed: true },
      { kind: "stop_confirm", sessionId: "session-1", stateVersion: 12, confirmed: false },
      { kind: "restart_prompt", sessionId: "session-1", stateVersion: 12 },
      { kind: "restart_confirm", sessionId: "session-1", stateVersion: 12, confirmed: true },
      { kind: "rewind_list", sessionId: "session-1", stateVersion: 12 },
      { kind: "rewind_prompt", sessionId: "session-1", stateVersion: 12, targetStepNo: 3 },
      {
        kind: "rewind_confirm",
        sessionId: "session-1",
        stateVersion: 12,
        targetStepNo: 3,
        confirmed: false,
      },
    ];

    for (const callback of callbacks) {
      const data = encodePrivateQuestCallback(callback);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(parsePrivateQuestCallback(data)).toEqual(callback);
    }
  });

  it("rejects identifiers that cannot fit without truncating callback data", () => {
    expect(() => encodePrivateQuestCallback({ kind: "quest", questId: "x".repeat(50) }))
      .toThrow(CallbackDataError);
    expect(() => encodePrivateQuestCallback({ kind: "quest", questId: " padded " }))
      .toThrow(CallbackDataError);
    expect(() => encodePrivateQuestCallback({
      kind: "choice",
      sessionId: "x".repeat(50),
      stateVersion: 0,
      choiceIndex: 0,
    })).toThrow(CallbackDataError);
    expect(() => encodePrivateQuestCallback({
      kind: "rewind_prompt",
      sessionId: "session-1",
      stateVersion: 0,
      targetStepNo: 0,
    })).toThrow(CallbackDataError);
    expect(() => encodePrivateQuestCallback({
      kind: "choice",
      sessionId: "session-a",
      stateVersion: -1,
      choiceIndex: 0,
    })).toThrow(CallbackDataError);
  });

  it("keeps maximal new navigation payloads within Telegram's 64-byte limit", () => {
    const callbacks: PrivateQuestCallback[] = [
      { kind: "quest_card", questId: "q".repeat(32), catalogPage: 2176782335, genreKey: "abcdefghijk", genrePage: 2176782335 },
      { kind: "history_page", sessionId: "b19c7550-3142-4a08-b0a5-3b18b9c40000", stateVersion: Number.MAX_SAFE_INTEGER, page: 2176782335 },
    ];
    for (const callback of callbacks) expect(Buffer.byteLength(encodePrivateQuestCallback(callback), "utf8")).toBeLessThanOrEqual(64);
  });

  it("returns null for malformed, non-canonical, unknown, and oversized callbacks", () => {
    const malformed = [
      "v2:m",
      "v1:m:extra",
      "v1:q:%%%",
      "v1:q:YQ==",
      "v1:v:YQ",
      "v1:s:YQ",
      "v1:c:YQ:00:0",
      "v1:c:YQ:zzzzzzzzzzzz:0",
      "v1:c:YQ:1",
      "v1:p:YQ:00",
      "v1:T:YQ:1:yes",
      "v1:w:YQ:1:0",
      "v1:W:YQ:1:0:1",
      "v1:W:YQ:1:2:x",
      "v1:unknown",
      `v1:q:${"a".repeat(80)}`,
    ];

    for (const data of malformed) {
      expect(parsePrivateQuestCallback(data)).toBeNull();
    }
    expect(parsePrivateQuestCallback({})).toBeNull();
  });
});
