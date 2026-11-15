import type { InlineKeyboardMarkup } from "grammy/types";

const TELEGRAM_MESSAGE_LIMIT_CODE_POINTS = 4096;
const SAFE_SCENE_CHUNK_CODE_POINTS = 3900;
const MAX_DRAFT_PREVIEWS = 3;
const MAX_DRAFT_ID = 2_147_483_647;

export interface SceneTelegramApi {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: { reply_markup: InlineKeyboardMarkup },
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
): Promise<void> {
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
      return;
    }
    previousLength = previewLength;
  }
}

export async function sendScene(
  api: SceneTelegramApi,
  chatId: number | string,
  text: string,
  updateId: number,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  const chunks = splitSceneText(text);
  if (chunks.length === 0) {
    if (keyboard !== undefined) {
      await api.sendMessage(chatId, "Выберите действие.", { reply_markup: keyboard });
    }
    return;
  }

  for (const [index, chunk] of chunks.entries()) {
    if (typeof chatId === "number") {
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
