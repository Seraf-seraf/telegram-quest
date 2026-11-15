import { Buffer } from "node:buffer";

const CALLBACK_PROTOCOL_VERSION = "v1";
const QUEST_CALLBACK_PROTOCOL_VERSION = "q2";
const MAX_CALLBACK_DATA_BYTES = 64;

export type PrivateQuestCallback =
  | { kind: "menu" }
  | { kind: "quests" }
  | { kind: "quest"; questId: string }
  | { kind: "start"; questId: string }
  | { kind: "sessions" }
  | { kind: "sessions_page"; cursor: string }
  | { kind: "genres_page"; page: number }
  | { kind: "genre"; key: string; genrePage: number }
  | { kind: "quests_page"; page: number; genreKey: string | null; genrePage: number }
  | { kind: "quest_card"; questId: string; catalogPage: number; genreKey: string | null; genrePage: number }
  | { kind: "sessions_number_page"; page: number }
  | { kind: "history_page"; sessionId: string; stateVersion: number; page: number }
  | { kind: "history_target"; sessionId: string; stateVersion: number; targetStepNo: number }
  | { kind: "noop" }
  | { kind: "session"; sessionId: string }
  | {
    kind: "choice";
    sessionId: string;
    stateVersion: number;
    choiceIndex: number;
  }
  | { kind: "manage"; sessionId: string; stateVersion: number }
  | { kind: "pause"; sessionId: string; stateVersion: number }
  | { kind: "resume"; sessionId: string; stateVersion: number }
  | { kind: "stop_prompt"; sessionId: string; stateVersion: number }
  | { kind: "stop_confirm"; sessionId: string; stateVersion: number; confirmed: boolean }
  | { kind: "restart_prompt"; sessionId: string; stateVersion: number }
  | { kind: "restart_confirm"; sessionId: string; stateVersion: number; confirmed: boolean }
  | { kind: "rewind_list"; sessionId: string; stateVersion: number }
  | { kind: "rewind_prompt"; sessionId: string; stateVersion: number; targetStepNo: number }
  | {
    kind: "rewind_confirm";
    sessionId: string;
    stateVersion: number;
    targetStepNo: number;
    confirmed: boolean;
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

function encodePositiveIndex(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new CallbackDataError();
  }
  return index.toString(36);
}

const MAX_PAGE_NUMBER = 2_176_782_335; // 36^6 - 1 keeps the largest full-context callback within 64 bytes.

function encodePage(page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE_NUMBER) {
    throw new CallbackDataError();
  }
  return page.toString(36);
}

function decodePage(token: string | undefined): number | null {
  const page = token === undefined ? null : decodeIndex(token);
  return page !== null && page >= 1 && page <= MAX_PAGE_NUMBER ? page : null;
}

function encodeCompactIdentifier(id: string, maximumLength: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > maximumLength) throw new CallbackDataError();
  return id;
}

function decodeCompactIdentifier(token: string | undefined, maximumLength: number): string | null {
  return token !== undefined && token.length <= maximumLength && /^[A-Za-z0-9_-]+$/.test(token)
    ? token
    : null;
}

function decodeIndex(token: string | undefined): number | null {
  if (token === undefined || !/^(0|[1-9a-z][0-9a-z]*)$/.test(token)) {
    return null;
  }

  const index = Number.parseInt(token, 36);
  return Number.isSafeInteger(index) && index.toString(36) === token ? index : null;
}

function encodeBoolean(value: boolean): string {
  return value ? "1" : "0";
}

function decodeBoolean(token: string | undefined): boolean | null {
  if (token === "1") {
    return true;
  }
  if (token === "0") {
    return false;
  }
  return null;
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
      data = `${QUEST_CALLBACK_PROTOCOL_VERSION}:c:${encodeId(callback.questId)}`;
      break;
    case "start":
      data = `${QUEST_CALLBACK_PROTOCOL_VERSION}:s:${encodeId(callback.questId)}`;
      break;
    case "sessions":
      data = `${CALLBACK_PROTOCOL_VERSION}:l`;
      break;
    case "sessions_page":
      data = `${CALLBACK_PROTOCOL_VERSION}:l:${encodeId(callback.cursor)}`;
      break;
    case "genres_page":
      data = `${CALLBACK_PROTOCOL_VERSION}:g:${encodePage(callback.page)}`;
      break;
    case "genre":
      data = `${CALLBACK_PROTOCOL_VERSION}:G:${encodeCompactIdentifier(callback.key, 11)}:${encodePage(callback.genrePage)}`;
      break;
    case "quests_page":
      data = `${CALLBACK_PROTOCOL_VERSION}:Q:${encodePage(callback.page)}:${callback.genreKey === null ? "-" : encodeCompactIdentifier(callback.genreKey, 11)}:${encodePage(callback.genrePage)}`;
      break;
    case "quest_card":
      data = `${CALLBACK_PROTOCOL_VERSION}:C:${encodeCompactIdentifier(callback.questId, 32)}:${encodePage(callback.catalogPage)}:${callback.genreKey === null ? "-" : encodeCompactIdentifier(callback.genreKey, 11)}:${encodePage(callback.genrePage)}`;
      break;
    case "sessions_number_page":
      data = `${CALLBACK_PROTOCOL_VERSION}:L:${encodePage(callback.page)}`;
      break;
    case "history_page":
      data = `${CALLBACK_PROTOCOL_VERSION}:H:${encodeCompactIdentifier(callback.sessionId, 36)}:${encodeIndex(callback.stateVersion)}:${encodePage(callback.page)}`;
      break;
    case "history_target":
      data = `${CALLBACK_PROTOCOL_VERSION}:J:${encodeCompactIdentifier(callback.sessionId, 36)}:${encodeIndex(callback.stateVersion)}:${encodePositiveIndex(callback.targetStepNo)}`;
      break;
    case "noop":
      data = `${CALLBACK_PROTOCOL_VERSION}:n`;
      break;
    case "session":
      data = `${CALLBACK_PROTOCOL_VERSION}:o:${encodeId(callback.sessionId)}`;
      break;
    case "choice":
      data = `${CALLBACK_PROTOCOL_VERSION}:c:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}:${encodeIndex(callback.choiceIndex)}`;
      break;
    case "manage":
      data = `${CALLBACK_PROTOCOL_VERSION}:a:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}`;
      break;
    case "pause":
      data = `${CALLBACK_PROTOCOL_VERSION}:p:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}`;
      break;
    case "resume":
      data = `${CALLBACK_PROTOCOL_VERSION}:u:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}`;
      break;
    case "stop_prompt":
      data = `${CALLBACK_PROTOCOL_VERSION}:t:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}`;
      break;
    case "stop_confirm":
      data = `${CALLBACK_PROTOCOL_VERSION}:T:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}:${encodeBoolean(callback.confirmed)}`;
      break;
    case "restart_prompt":
      data = `${CALLBACK_PROTOCOL_VERSION}:r:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}`;
      break;
    case "restart_confirm":
      data = `${CALLBACK_PROTOCOL_VERSION}:R:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}:${encodeBoolean(callback.confirmed)}`;
      break;
    case "rewind_list":
      data = `${CALLBACK_PROTOCOL_VERSION}:h:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}`;
      break;
    case "rewind_prompt":
      data = `${CALLBACK_PROTOCOL_VERSION}:w:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}:${encodePositiveIndex(callback.targetStepNo)}`;
      break;
    case "rewind_confirm":
      data = `${CALLBACK_PROTOCOL_VERSION}:W:${encodeId(callback.sessionId)}:${encodeIndex(callback.stateVersion)}:${encodePositiveIndex(callback.targetStepNo)}:${encodeBoolean(callback.confirmed)}`;
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
  const protocol = parts[0];
  const operation = parts[1];
  if (protocol === QUEST_CALLBACK_PROTOCOL_VERSION) {
    if (parts.length !== 3) {
      return null;
    }
    const questId = decodeId(parts[2]);
    if (questId === null) {
      return null;
    }
    if (operation === "c") {
      return { kind: "quest", questId };
    }
    if (operation === "s") {
      return { kind: "start", questId };
    }
    return null;
  }

  if (protocol !== CALLBACK_PROTOCOL_VERSION) {
    return null;
  }

  switch (operation) {
    case "g": {
      if (parts.length !== 3) return null;
      const page = decodePage(parts[2]);
      return page === null ? null : { kind: "genres_page", page };
    }
    case "G": {
      if (parts.length !== 4) return null;
      const key = decodeCompactIdentifier(parts[2], 11);
      const genrePage = decodePage(parts[3]);
      return key === null || key.length !== 11 || genrePage === null ? null : { kind: "genre", key, genrePage };
    }
    case "Q":
    case "C": {
      if (parts.length !== (operation === "Q" ? 5 : 6)) return null;
      const page = decodePage(parts[operation === "Q" ? 2 : 3]);
      const id = operation === "Q" ? null : decodeCompactIdentifier(parts[2], 32);
      const genreToken = parts[operation === "Q" ? 3 : 4];
      const genreKey = genreToken === "-" ? null : decodeCompactIdentifier(genreToken, 11);
      const genrePage = decodePage(parts[operation === "Q" ? 4 : 5]);
      if (page === null || genrePage === null || (genreToken !== "-" && (genreKey === null || genreKey.length !== 11))) return null;
      return operation === "Q"
        ? { kind: "quests_page", page, genreKey, genrePage }
        : id === null ? null : { kind: "quest_card", questId: id, catalogPage: page, genreKey, genrePage };
    }
    case "L": {
      if (parts.length !== 3) return null;
      const page = decodePage(parts[2]);
      return page === null ? null : { kind: "sessions_number_page", page };
    }
    case "H":
    case "J": {
      if (parts.length !== 5) return null;
      const sessionId = decodeCompactIdentifier(parts[2], 36);
      const stateVersion = decodeIndex(parts[3]);
      const value = operation === "H" ? decodePage(parts[4]) : decodeIndex(parts[4]);
      return sessionId === null || stateVersion === null || value === null || (operation === "J" && value < 1)
        ? null
        : operation === "H"
          ? { kind: "history_page", sessionId, stateVersion, page: value }
          : { kind: "history_target", sessionId, stateVersion, targetStepNo: value };
    }
    case "n":
      return parts.length === 2 ? { kind: "noop" } : null;
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
    case "a":
    case "p":
    case "u":
    case "t":
    case "r":
    case "h": {
      if (parts.length !== 4) {
        return null;
      }
      const sessionId = decodeId(parts[2]);
      const stateVersion = decodeIndex(parts[3]);
      if (sessionId === null || stateVersion === null) {
        return null;
      }
      switch (operation) {
        case "a":
          return { kind: "manage", sessionId, stateVersion };
        case "p":
          return { kind: "pause", sessionId, stateVersion };
        case "u":
          return { kind: "resume", sessionId, stateVersion };
        case "t":
          return { kind: "stop_prompt", sessionId, stateVersion };
        case "r":
          return { kind: "restart_prompt", sessionId, stateVersion };
        case "h":
          return { kind: "rewind_list", sessionId, stateVersion };
      }
      return null;
    }
    case "T":
    case "R": {
      if (parts.length !== 5) {
        return null;
      }
      const sessionId = decodeId(parts[2]);
      const stateVersion = decodeIndex(parts[3]);
      const confirmed = decodeBoolean(parts[4]);
      if (sessionId === null || stateVersion === null || confirmed === null) {
        return null;
      }
      return operation === "T"
        ? { kind: "stop_confirm", sessionId, stateVersion, confirmed }
        : { kind: "restart_confirm", sessionId, stateVersion, confirmed };
    }
    case "w": {
      if (parts.length !== 5) {
        return null;
      }
      const sessionId = decodeId(parts[2]);
      const stateVersion = decodeIndex(parts[3]);
      const targetStepNo = decodeIndex(parts[4]);
      return sessionId === null || stateVersion === null || targetStepNo === null || targetStepNo < 1
        ? null
        : { kind: "rewind_prompt", sessionId, stateVersion, targetStepNo };
    }
    case "W": {
      if (parts.length !== 6) {
        return null;
      }
      const sessionId = decodeId(parts[2]);
      const stateVersion = decodeIndex(parts[3]);
      const targetStepNo = decodeIndex(parts[4]);
      const confirmed = decodeBoolean(parts[5]);
      return sessionId === null || stateVersion === null || targetStepNo === null || targetStepNo < 1 || confirmed === null
        ? null
        : { kind: "rewind_confirm", sessionId, stateVersion, targetStepNo, confirmed };
    }
    default:
      return null;
  }
}
