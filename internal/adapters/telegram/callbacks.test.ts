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
      { kind: "version", versionId: "f019c76d-8279-4a50-80b1-14be643f0000" },
      { kind: "start", versionId: "f019c76d-8279-4a50-80b1-14be643f0000" },
      { kind: "sessions" },
      { kind: "sessions_page", cursor: "session-cursor" },
      { kind: "session", sessionId: "b19c7550-3142-4a08-b0a5-3b18b9c40000" },
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
  });

  it("returns null for malformed, non-canonical, unknown, and oversized callbacks", () => {
    const malformed = [
      "v2:m",
      "v1:m:extra",
      "v1:q:%%%",
      "v1:q:YQ==",
      "v1:unknown",
      `v1:q:${"a".repeat(80)}`,
    ];

    for (const data of malformed) {
      expect(parsePrivateQuestCallback(data)).toBeNull();
    }
    expect(parsePrivateQuestCallback({})).toBeNull();
  });
});
