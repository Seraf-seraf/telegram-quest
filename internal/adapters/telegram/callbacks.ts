import { Buffer } from "node:buffer";

const CALLBACK_PROTOCOL_VERSION = "v1";
const MAX_CALLBACK_DATA_BYTES = 64;

export type PrivateQuestCallback =
  | { kind: "menu" }
  | { kind: "quests" }
  | { kind: "quest"; questId: string }
  | { kind: "version"; versionId: string }
  | { kind: "start"; versionId: string }
  | { kind: "sessions" }
  | { kind: "sessions_page"; cursor: string }
  | { kind: "session"; sessionId: string }
  | {
    kind: "choice";
    sessionId: string;
    stateVersion: number;
    choiceIndex: number;
  };

export class CallbackDataError extends Error {
  public constructor() {
    super("Callback data is invalid or exceeds Telegram limits.");
    this.name = "CallbackDataError";
  }
}

function encodeId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    throw new CallbackDataError();
  }

  const bytes = Buffer.from(id, "utf8");
  if (bytes.toString("utf8") !== id) {
    throw new CallbackDataError();
  }

  const token = bytes.toString("base64url");
  if (token.length === 0) {
    throw new CallbackDataError();
  }
  return token;
}

function decodeId(token: string | undefined): string | null {
  if (token === undefined || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }

  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) {
    return null;
  }

  const id = bytes.toString("utf8");
  return id.length > 0 && id.trim() === id && Buffer.from(id, "utf8").equals(bytes)
    ? id
    : null;
}

function encodeIndex(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new CallbackDataError();
  }
  return index.toString(36);
}

function decodeIndex(token: string | undefined): number | null {
  if (token === undefined || !/^(0|[1-9a-z][0-9a-z]*)$/.test(token)) {
    return null;
  }

  const index = Number.parseInt(token, 36);
  return Number.isSafeInteger(index) && index.toString(36) === token ? index : null;
}

function assertCallbackLength(data: string): string {
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) {
    throw new CallbackDataError();
  }
  return data;
}

export function encodePrivateQuestCallback(callback: PrivateQuestCallback): string {
  let data: string;

  switch (callback.kind) {
    case "menu":
      data = `${CALLBACK_PROTOCOL_VERSION}:m`;
      break;
    case "quests":
      data = `${CALLBACK_PROTOCOL_VERSION}:q`;
      break;
    case "quest":
      data = `${CALLBACK_PROTOCOL_VERSION}:q:${encodeId(callback.questId)}`;
      break;
    case "version":
      data = `${CALLBACK_PROTOCOL_VERSION}:v:${encodeId(callback.versionId)}`;
      break;
    case "start":
      data = `${CALLBACK_PROTOCOL_VERSION}:s:${encodeId(callback.versionId)}`;
      break;
    case "sessions":
      data = `${CALLBACK_PROTOCOL_VERSION}:l`;
      break;
    case "sessions_page":
      data = `${CALLBACK_PROTOCOL_VERSION}:l:${encodeId(callback.cursor)}`;
      break;
    case "session":
      data = `${CALLBACK_PROTOCOL_VERSION}:o:${encodeId(callback.sessionId)}`;
      break;
    case "choice":
      data = `${CALLBACK_PROTOCOL_VERSION}:c:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}:${encodeIndex(callback.choiceIndex)}`;
      break;
    default: {
      const exhaustive: never = callback;
      throw new CallbackDataError();
    }
  }

  return assertCallbackLength(data);
}

export function parsePrivateQuestCallback(data: unknown): PrivateQuestCallback | null {
  if (
    typeof data !== "string" ||
    Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES
  ) {
    return null;
  }

  const parts = data.split(":");
  if (parts[0] !== CALLBACK_PROTOCOL_VERSION) {
    return null;
  }

  const operation = parts[1];
  switch (operation) {
    case "m":
      return parts.length === 2 ? { kind: "menu" } : null;
    case "q":
      if (parts.length === 2) {
        return { kind: "quests" };
      }
      if (parts.length === 3) {
        const questId = decodeId(parts[2]);
        return questId === null ? null : { kind: "quest", questId };
      }
      return null;
    case "v": {
      if (parts.length !== 3) {
        return null;
      }
      const versionId = decodeId(parts[2]);
      return versionId === null ? null : { kind: "version", versionId };
    }
    case "s": {
      if (parts.length !== 3) {
        return null;
      }
      const versionId = decodeId(parts[2]);
      return versionId === null ? null : { kind: "start", versionId };
    }
    case "l":
      if (parts.length === 2) {
        return { kind: "sessions" };
      }
      if (parts.length === 3) {
        const cursor = decodeId(parts[2]);
        return cursor === null ? null : { kind: "sessions_page", cursor };
      }
      return null;
    case "o": {
      if (parts.length !== 3) {
        return null;
      }
      const sessionId = decodeId(parts[2]);
      return sessionId === null ? null : { kind: "session", sessionId };
    }
    case "c": {
      if (parts.length !== 5) {
        return null;
      }
      const sessionId = decodeId(parts[2]);
      const stateVersion = decodeIndex(parts[3]);
      const choiceIndex = decodeIndex(parts[4]);
      return sessionId === null || stateVersion === null || choiceIndex === null
        ? null
        : { kind: "choice", sessionId, stateVersion, choiceIndex };
    }
    default:
      return null;
  }
}
