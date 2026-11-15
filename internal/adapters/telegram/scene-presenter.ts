import type { InlineKeyboardMarkup } from "grammy/types";
import type { ContentView } from "../../app/content.js";

const TELEGRAM_MESSAGE_LIMIT_CODE_POINTS = 4096;
const TELEGRAM_CAPTION_LIMIT_CODE_POINTS = 1024;
const SAFE_SCENE_CHUNK_CODE_POINTS = 3900;
const MAX_DRAFT_PREVIEWS = 3;
const MAX_DRAFT_ID = 2_147_483_647;
const DIALOGUE_PAUSE_MS = 300;

export interface SceneDisplayOptions {
  stream: boolean;
  replay: boolean;
  noPauseLines: readonly number[];
}

export interface SceneTelegramApi {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: { reply_markup: InlineKeyboardMarkup },
  ): Promise<unknown>;
  sendPhoto(
    chatId: number | string,
    photo: string,
    other?: { caption?: string; reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  sendMessageDraft(chatId: number, draftId: number, text: string): Promise<unknown>;
}

export function splitSceneText(text: string): string[] {
  const codePoints = [...text];
  if (codePoints.length === 0) {
    return [];
  }

  const chunkSize = codePoints.length <= TELEGRAM_MESSAGE_LIMIT_CODE_POINTS
    ? TELEGRAM_MESSAGE_LIMIT_CODE_POINTS
    : SAFE_SCENE_CHUNK_CODE_POINTS;
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += chunkSize) {
    chunks.push(codePoints.slice(offset, offset + chunkSize).join(""));
  }
  return chunks;
}

function draftIdFor(updateId: number, chunkIndex: number): number {
  const safeUpdateId = Number.isSafeInteger(updateId) && updateId >= 0 ? updateId : 0;
  return ((safeUpdateId + chunkIndex) % MAX_DRAFT_ID) + 1;
}

async function sendDraftPreviews(
  api: SceneTelegramApi,
  chatId: number,
  draftId: number,
  text: string,
): Promise<boolean> {
  const codePoints = [...text];
  let previousLength = 0;

  for (let previewIndex = 1; previewIndex <= MAX_DRAFT_PREVIEWS; previewIndex += 1) {
    const previewLength = Math.ceil((codePoints.length * previewIndex) / MAX_DRAFT_PREVIEWS);
    if (previewLength <= previousLength) {
      continue;
    }

    try {
      await api.sendMessageDraft(chatId, draftId, codePoints.slice(0, previewLength).join(""));
    } catch {
      return false;
    }
    previousLength = previewLength;
  }
  return true;
}

function dialoguePauseOffsets(text: string, noPauseLines: readonly number[]): number[] {
  const disabledLines = new Set(noPauseLines);
  const offsets: number[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (!disabledLines.has(lineNumber) && /^\s*[-–—]/u.test(line)) {
      const speech = line.matchAll(/\.\.\.|…/gu);
      for (const match of speech) {
        const end = (match.index ?? 0) + match[0].length;
        offsets.push(offset + [...line.slice(0, end)].length);
      }
    }
    offset += [...line].length + 1;
  }
  return offsets;
}

async function sendStreamPreviews(
  api: SceneTelegramApi,
  chatId: number,
  draftId: number,
  codePoints: readonly string[],
  start: number,
  end: number,
  pauseOffsets: readonly number[],
): Promise<boolean> {
  let previous = start;
  for (const boundary of pauseOffsets) {
    if (boundary <= start || boundary > end) continue;
    if (boundary > previous) {
      try {
        await api.sendMessageDraft(chatId, draftId, codePoints.slice(start, boundary).join(""));
      } catch {
        return false;
      }
      previous = boundary;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DIALOGUE_PAUSE_MS));
  }
  if (previous < end) {
    try {
      await api.sendMessageDraft(chatId, draftId, codePoints.slice(start, end).join(""));
    } catch {
      return false;
    }
  }
  return true;
}

function codePointLength(text: string): number {
  return [...text].length;
}

async function sendTextChunks(
  api: SceneTelegramApi,
  chatId: number | string,
  text: string,
  updateId: number,
  keyboard?: InlineKeyboardMarkup,
  suppressDrafts = false,
  startIndex = 0,
): Promise<void> {
  const chunks = splitSceneText(text);
  if (chunks.length === 0) {
    if (keyboard !== undefined) {
      await api.sendMessage(chatId, "Выберите действие.", { reply_markup: keyboard });
    }
    return;
  }

  for (let index = startIndex; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    if (typeof chatId === "number" && !suppressDrafts) {
      await sendDraftPreviews(api, chatId, draftIdFor(updateId, index), chunk);
    }

    const other = keyboard !== undefined && index === chunks.length - 1
      ? { reply_markup: keyboard }
      : undefined;
    if (other === undefined) {
      await api.sendMessage(chatId, chunk);
    } else {
      await api.sendMessage(chatId, chunk, other);
    }
  }
}

async function sendTextChunk(
  api: SceneTelegramApi,
  chatId: number | string,
  chunks: readonly string[],
  index: number,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  const chunk = chunks[index];
  if (chunk === undefined) return;
  const other = keyboard !== undefined && index === chunks.length - 1
    ? { reply_markup: keyboard }
    : undefined;
  if (other === undefined) {
    await api.sendMessage(chatId, chunk);
  } else {
    await api.sendMessage(chatId, chunk, other);
  }
}

export async function sendScene(
  api: SceneTelegramApi,
  chatId: number | string,
  view: ContentView,
  updateId: number,
  keyboard?: InlineKeyboardMarkup,
  display?: SceneDisplayOptions,
): Promise<void> {
  const stream = display?.stream === true && display.replay !== true;
  const sendText = async (): Promise<void> => {
    if (stream && typeof chatId === "number") {
      const codePoints = [...view.text];
      if (codePoints.length > 0) {
        const pauseOffsets = dialoguePauseOffsets(view.text, display?.noPauseLines ?? []);
        const chunks = splitSceneText(view.text);
        let start = 0;
        for (const [index, chunk] of chunks.entries()) {
          const end = start + [...chunk].length;
          const previewSucceeded = await sendStreamPreviews(
            api, chatId, draftIdFor(updateId, index), codePoints, start, end, pauseOffsets,
          );
          if (!previewSucceeded) {
            await sendTextChunks(api, chatId, view.text, updateId, keyboard, true, index);
            return;
          }
          await sendTextChunk(api, chatId, chunks, index, keyboard);
          start = end;
        }
        return;
      }
    }
    await sendTextChunks(api, chatId, view.text, updateId, keyboard);
  };

  if (view.imageUrl === undefined) {
    await sendText();
    return;
  }

  if (stream) {
    await api.sendPhoto(chatId, view.imageUrl);
    await sendText();
    return;
  }

  if (codePointLength(view.text) <= TELEGRAM_CAPTION_LIMIT_CODE_POINTS) {
    if (view.text.length > 0 && typeof chatId === "number") {
      await sendDraftPreviews(api, chatId, draftIdFor(updateId, 0), view.text);
    }
    await api.sendPhoto(chatId, view.imageUrl, {
      ...(view.text.length === 0 ? {} : { caption: view.text }),
      ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
    });
    return;
  }

  await api.sendPhoto(chatId, view.imageUrl);
  await sendTextChunks(api, chatId, view.text, updateId, keyboard);
}
