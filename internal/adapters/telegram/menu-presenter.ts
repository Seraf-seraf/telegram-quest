import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { ContentView } from "../../app/content.js";

const TELEGRAM_MESSAGE_LIMIT_CODE_POINTS = 4096;
const TELEGRAM_CAPTION_LIMIT_CODE_POINTS = 1024;
const SAFE_MENU_CHUNK_CODE_POINTS = 3900;
const MAX_TRACKED_MENU_SCREENS = 512;

export interface MenuTelegramApi {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  sendPhoto(
    chatId: number | string,
    photo: string,
    other?: { caption?: string; reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    other?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  editMessageMedia(
    chatId: number | string,
    messageId: number,
    media: { type: "photo"; media: string; caption?: string },
    other?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  deleteMessage(chatId: number | string, messageId: number): Promise<unknown>;
  editMessageReplyMarkup(
    chatId: number | string,
    messageId: number,
    other: { reply_markup: InlineKeyboardMarkup },
  ): Promise<unknown>;
}

export interface ExistingMenuMessage {
  messageId: number;
  hasPhoto: boolean;
  callbackMessageId: number;
  messageIds: number[];
  complete?: boolean;
}

interface TrackedMenuScreen extends ExistingMenuMessage {
  callbackData: Set<string>;
}

const trackedScreens = new Map<string, TrackedMenuScreen>();

function chatMessageKey(chatId: number | string, messageId: number): string {
  return `${typeof chatId}:${String(chatId)}:${messageId}`;
}

function callbackDataFor(keyboard: InlineKeyboardMarkup): Set<string> {
  const callbackData = new Set<string>();
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      if ("callback_data" in button && typeof button.callback_data === "string") {
        callbackData.add(button.callback_data);
      }
    }
  }
  return callbackData;
}

function trackedScreen(
  chatId: number | string,
  callbackMessageId: number,
): TrackedMenuScreen | undefined {
  return trackedScreens.get(chatMessageKey(chatId, callbackMessageId));
}

function registerScreen(chatId: number | string, screen: TrackedMenuScreen): void {
  const chatPrefix = `${typeof chatId}:${String(chatId)}:`;
  for (const key of trackedScreens.keys()) {
    if (key.startsWith(chatPrefix)) {
      trackedScreens.delete(key);
    }
  }
  const key = chatMessageKey(chatId, screen.callbackMessageId);
  trackedScreens.set(key, screen);
  while (trackedScreens.size > MAX_TRACKED_MENU_SCREENS) {
    const oldestKey = trackedScreens.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    trackedScreens.delete(oldestKey);
  }
}

function forgetScreen(chatId: number | string, screen: ExistingMenuMessage): void {
  for (const messageId of screen.messageIds) {
    trackedScreens.delete(chatMessageKey(chatId, messageId));
  }
}

function messageIdFrom(result: unknown): number {
  if (typeof result === "object" && result !== null && "message_id" in result) {
    const messageId = result.message_id;
    if (typeof messageId === "number" && Number.isSafeInteger(messageId)) {
      return messageId;
    }
  }
  throw new Error("Telegram did not return a message id for a menu message.");
}

function codePointLength(text: string): number {
  return [...text].length;
}

function splitMenuText(text: string): string[] {
  const codePoints = [...text];
  if (codePoints.length === 0) {
    return [];
  }
  if (codePoints.length <= TELEGRAM_MESSAGE_LIMIT_CODE_POINTS) {
    return [text];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += SAFE_MENU_CHUNK_CODE_POINTS) {
    chunks.push(codePoints.slice(offset, offset + SAFE_MENU_CHUNK_CODE_POINTS).join(""));
  }
  return chunks;
}

async function sendTextMenu(
  api: MenuTelegramApi,
  chatId: number | string,
  text: string,
  keyboard: InlineKeyboardMarkup,
): Promise<number[]> {
  const chunks = splitMenuText(text.length === 0 ? "Выберите действие." : text);
  const messageIds: number[] = [];
  try {
    for (const [index, chunk] of chunks.entries()) {
      const replyMarkup = index === chunks.length - 1 ? { reply_markup: keyboard } : undefined;
      const result = replyMarkup === undefined
        ? await api.sendMessage(chatId, chunk)
        : await api.sendMessage(chatId, chunk, replyMarkup);
      messageIds.push(messageIdFrom(result));
    }
  } catch (error) {
    await cleanupMessageIds(api, chatId, messageIds);
    throw error;
  }
  return messageIds;
}

async function sendPhotoMenu(
  api: MenuTelegramApi,
  chatId: number | string,
  view: ContentView,
  keyboard: InlineKeyboardMarkup,
): Promise<{ messageIds: number[]; callbackMessageId: number }> {
  const imageUrl = view.imageUrl;
  if (imageUrl === undefined) {
    throw new Error("A photo menu requires an image URL.");
  }

  if (codePointLength(view.text) <= TELEGRAM_CAPTION_LIMIT_CODE_POINTS) {
    const result = await api.sendPhoto(chatId, imageUrl, {
      ...(view.text.length === 0 ? {} : { caption: view.text }),
      reply_markup: keyboard,
    });
    const messageId = messageIdFrom(result);
    return { messageIds: [messageId], callbackMessageId: messageId };
  }

  const photoResult = await api.sendPhoto(chatId, imageUrl);
  const photoMessageId = messageIdFrom(photoResult);
  try {
    const textMessageIds = await sendTextMenu(api, chatId, view.text, keyboard);
    return {
      messageIds: [photoMessageId, ...textMessageIds],
      callbackMessageId: textMessageIds.at(-1) ?? photoMessageId,
    };
  } catch (error) {
    await cleanupMessageIds(api, chatId, [photoMessageId]);
    throw error;
  }
}

async function cleanupMessageIds(
  api: MenuTelegramApi,
  chatId: number | string,
  messageIds: readonly number[],
  preserve: ReadonlySet<number> = new Set(),
): Promise<void> {
  for (const messageId of messageIds) {
    if (preserve.has(messageId)) {
      continue;
    }
    try {
      await api.deleteMessage(chatId, messageId);
    } catch {
      try {
        await api.editMessageReplyMarkup(chatId, messageId, {
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // The old menu may already be gone or may no longer be editable.
      }
    }
  }
}

function isMessageNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/iu.test(error.description);
}

async function editTextMenu(
  api: MenuTelegramApi,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard: InlineKeyboardMarkup,
): Promise<boolean> {
  try {
    await api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
    return true;
  } catch (error) {
    if (isMessageNotModified(error)) {
      return false;
    }
    throw error;
  }
}

async function editPhotoMenu(
  api: MenuTelegramApi,
  chatId: number | string,
  messageId: number,
  imageUrl: string,
  text: string,
  keyboard: InlineKeyboardMarkup,
): Promise<boolean> {
  try {
    await api.editMessageMedia(chatId, messageId, {
      type: "photo",
      media: imageUrl,
      ...(text.length === 0 ? {} : { caption: text }),
    }, { reply_markup: keyboard });
    return true;
  } catch (error) {
    if (isMessageNotModified(error)) {
      return false;
    }
    throw error;
  }
}

function recordSuccessfulScreen(
  chatId: number | string,
  existing: ExistingMenuMessage | undefined,
  screen: ExistingMenuMessage,
  callbackData: Set<string>,
): void {
  if (existing !== undefined) {
    forgetScreen(chatId, existing);
  }
  registerScreen(chatId, { ...screen, callbackData });
}

async function presentCompositePhotoMenu(
  api: MenuTelegramApi,
  chatId: number | string,
  existing: ExistingMenuMessage,
  view: ContentView,
  keyboard: InlineKeyboardMarkup,
): Promise<void> {
  const imageUrl = view.imageUrl;
  if (imageUrl === undefined) {
    throw new Error("A composite photo menu requires an image URL.");
  }

  const photoMessageId = existing.hasPhoto ? existing.messageId : existing.callbackMessageId;
  const previousScreen = trackedScreen(chatId, existing.callbackMessageId);
  forgetScreen(chatId, existing);
  try {
    await editPhotoMenu(
      api,
      chatId,
      photoMessageId,
      imageUrl,
      "",
      { inline_keyboard: [] },
    );
  } catch (error) {
    if (previousScreen !== undefined) {
      registerScreen(chatId, previousScreen);
    }
    throw error;
  }

  let textMessageIds: number[];
  try {
    textMessageIds = await sendTextMenu(api, chatId, view.text, keyboard);
  } catch (error) {
    await cleanupMessageIds(api, chatId, existing.messageIds);
    throw error;
  }

  await cleanupMessageIds(api, chatId, existing.messageIds, new Set([photoMessageId]));
  registerScreen(chatId, {
    messageId: photoMessageId,
    hasPhoto: true,
    callbackMessageId: textMessageIds.at(-1) ?? photoMessageId,
    messageIds: [photoMessageId, ...textMessageIds],
    callbackData: callbackDataFor(keyboard),
  });
}

export async function presentMenu(
  api: MenuTelegramApi,
  chatId: number | string,
  existing: ExistingMenuMessage | undefined,
  view: ContentView,
  keyboard: InlineKeyboardMarkup,
): Promise<void> {
  const callbackData = callbackDataFor(keyboard);
  const singlePhoto = view.imageUrl !== undefined &&
    codePointLength(view.text) <= TELEGRAM_CAPTION_LIMIT_CODE_POINTS;
  const singleText = view.imageUrl === undefined &&
    codePointLength(view.text) <= TELEGRAM_MESSAGE_LIMIT_CODE_POINTS;

  if (
    existing !== undefined &&
    existing.complete !== false &&
    view.imageUrl !== undefined &&
    !singlePhoto
  ) {
    await presentCompositePhotoMenu(
      api,
      chatId,
      existing,
      view,
      keyboard,
    );
    return;
  }

  const canEditExisting = existing !== undefined && existing.complete !== false &&
    existing.messageIds.length === 1 &&
    (singlePhoto || (singleText && !existing.hasPhoto));

  if (canEditExisting && existing !== undefined) {
    const messageId = existing.messageIds[0] ?? existing.messageId;
    const modified = singlePhoto
      ? await editPhotoMenu(api, chatId, messageId, view.imageUrl ?? "", view.text, keyboard)
      : await editTextMenu(
        api,
        chatId,
        messageId,
        view.text.length === 0 ? "Выберите действие." : view.text,
        keyboard,
      );
    if (!modified) {
      return;
    }

    const hasPhoto = singlePhoto;
    recordSuccessfulScreen(chatId, existing, {
      messageId,
      hasPhoto,
      callbackMessageId: messageId,
      messageIds: [messageId],
    }, callbackData);
    return;
  }

  let screen: ExistingMenuMessage;
  if (view.imageUrl !== undefined) {
    const sent = await sendPhotoMenu(api, chatId, view, keyboard);
    screen = {
      messageId: sent.messageIds[0] ?? sent.callbackMessageId,
      hasPhoto: true,
      callbackMessageId: sent.callbackMessageId,
      messageIds: sent.messageIds,
    };
  } else {
    const messageIds = await sendTextMenu(api, chatId, view.text, keyboard);
    const callbackMessageId = messageIds.at(-1);
    if (callbackMessageId === undefined) {
      throw new Error("Telegram did not return a callback menu message id.");
    }
    screen = {
      messageId: callbackMessageId,
      hasPhoto: false,
      callbackMessageId,
      messageIds,
    };
  }

  if (existing !== undefined) {
    if (existing.complete === false) {
      try {
        await api.editMessageReplyMarkup(chatId, existing.callbackMessageId, {
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // Keep the replacement screen even if the old composite keyboard cannot be cleared.
      }
    } else {
      await cleanupMessageIds(api, chatId, existing.messageIds);
    }
    forgetScreen(chatId, existing);
  }
  registerScreen(chatId, { ...screen, callbackData });
}

export function resolveMenuCallbackData(
  data: string | undefined,
  replyMarkup?: InlineKeyboardMarkup,
): string | null {
  if (data === undefined) {
    return null;
  }
  if (replyMarkup !== undefined) {
    const containsCallback = replyMarkup.inline_keyboard.some((row) => row.some((button) =>
      "callback_data" in button && button.callback_data === data
    ));
    if (!containsCallback) {
      return null;
    }
  }
  return data;
}

export function getExistingMenuMessage(
  chatId: number | string,
  callbackMessageId: number,
  messageHasPhoto: boolean,
  callbackData: string | undefined,
): ExistingMenuMessage | undefined {
  if (callbackData === undefined) {
    return undefined;
  }
  const screen = trackedScreen(chatId, callbackMessageId);
  if (screen !== undefined && screen.callbackData.has(callbackData)) {
    return {
      messageId: screen.messageId,
      hasPhoto: screen.hasPhoto,
      callbackMessageId: screen.callbackMessageId,
      messageIds: [...screen.messageIds],
      complete: true,
    };
  }
  return {
    messageId: callbackMessageId,
    hasPhoto: messageHasPhoto,
    callbackMessageId,
    messageIds: [callbackMessageId],
    complete: messageHasPhoto,
  };
}
