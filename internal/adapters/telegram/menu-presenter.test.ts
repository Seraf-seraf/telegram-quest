import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  getExistingMenuMessage,
  presentMenu,
  resolveMenuCallbackData,
  type MenuTelegramApi,
} from "./menu-presenter.js";

interface TelegramCall {
  method: string;
  args: unknown[];
  result: unknown;
}

let nextTestMessageId = 100;

function createApi(): {
  api: MenuTelegramApi;
  calls: TelegramCall[];
  failNext: (method: string, error: Error) => void;
} {
  const calls: TelegramCall[] = [];
  const failures = new Map<string, Error>();
  const record = (method: string) => async (...args: unknown[]): Promise<unknown> => {
    const result = method === "sendMessage" || method === "sendPhoto"
      ? { message_id: nextTestMessageId++ }
      : ["editMessageText", "editMessageMedia"].includes(method)
        ? { message_id: args[1] }
        : true;
    calls.push({ method, args, result });
    const error = failures.get(method);
    if (error !== undefined) {
      failures.delete(method);
      throw error;
    }
    return result;
  };
  const api: MenuTelegramApi = {
    sendMessage: record("sendMessage"),
    sendPhoto: record("sendPhoto"),
    editMessageText: record("editMessageText"),
    editMessageMedia: record("editMessageMedia"),
    deleteMessage: record("deleteMessage"),
    editMessageReplyMarkup: record("editMessageReplyMarkup"),
  };
  return { api, calls, failNext: (method, error) => failures.set(method, error) };
}

function telegramError(description: string, method: string): GrammyError {
  return new GrammyError(description, {
    ok: false,
    error_code: 400,
    description,
  }, method, {});
}

const keyboard: InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: "Открыть", callback_data: "q2:open" }]],
};
const currentTextMenu = {
  messageId: 10,
  hasPhoto: false,
  callbackMessageId: 10,
  messageIds: [10],
};
const currentPhotoMenu = {
  messageId: 11,
  hasPhoto: true,
  callbackMessageId: 11,
  messageIds: [11],
};

describe("menu presenter", () => {
  it("sends a new photo menu with caption and keyboard", async () => {
    const { api, calls } = createApi();

    await presentMenu(api, 41, undefined, {
      imageUrl: "https://assets.example/menu.jpg",
      text: "Главное меню",
    }, keyboard);

    expect(calls).toMatchObject([{
      method: "sendPhoto",
      args: [41, "https://assets.example/menu.jpg", { caption: "Главное меню" }],
    }]);
    const sentMarkup = calls[0]?.args[2] as { reply_markup: InlineKeyboardMarkup };
    expect(sentMarkup.reply_markup).toEqual(keyboard);
  });

  it("edits text menus in place and edits text messages to media", async () => {
    const textApi = createApi();
    await presentMenu(textApi.api, 41, currentTextMenu, { text: "Каталог" }, keyboard);
    expect(textApi.calls.map((call) => call.method)).toEqual(["editMessageText"]);
    expect(textApi.calls[0]?.args.slice(0, 3)).toEqual([41, 10, "Каталог"]);
    const textMarkup = textApi.calls[0]?.args[3] as { reply_markup: InlineKeyboardMarkup };
    expect(textMarkup.reply_markup).toEqual(keyboard);

    const mediaApi = createApi();
    await presentMenu(mediaApi.api, 41, currentTextMenu, {
      imageUrl: "https://assets.example/cover-v2.jpg",
      text: "Карточка квеста",
    }, keyboard);
    expect(mediaApi.calls.map((call) => call.method)).toEqual(["editMessageMedia"]);
    expect(mediaApi.calls[0]?.args.slice(0, 3)).toEqual([41, 10, {
      type: "photo",
      media: "https://assets.example/cover-v2.jpg",
      caption: "Карточка квеста",
    }]);
    const mediaMarkup = mediaApi.calls[0]?.args[3] as { reply_markup: InlineKeyboardMarkup };
    expect(mediaMarkup.reply_markup).toEqual(keyboard);
  });

  it("replaces media with a new URL and retains the keyboard", async () => {
    const { api, calls } = createApi();

    await presentMenu(api, 41, currentPhotoMenu, {
      imageUrl: "https://assets.example/new-cover.jpg",
      text: "Обновлённая карточка",
    }, keyboard);

    expect(calls.map((call) => call.method)).toEqual(["editMessageMedia"]);
    expect(calls[0]?.args[2]).toMatchObject({
      type: "photo",
      media: "https://assets.example/new-cover.jpg",
      caption: "Обновлённая карточка",
    });
  });

  it("sends replacement text before deleting a media menu", async () => {
    const { api, calls } = createApi();

    await presentMenu(api, 41, currentPhotoMenu, { text: "Текстовый экран" }, keyboard);

    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "deleteMessage"]);
    expect(calls[0]?.args.slice(0, 2)).toEqual([41, "Текстовый экран"]);
    const sentMarkup = calls[0]?.args[2] as { reply_markup: InlineKeyboardMarkup };
    expect(sentMarkup.reply_markup).toEqual(keyboard);
    expect(calls[1]?.args).toEqual([41, 11]);
  });

  it("removes the old keyboard if the old media menu cannot be deleted", async () => {
    const { api, calls, failNext } = createApi();
    failNext("deleteMessage", new Error("delete failed"));

    await presentMenu(api, 41, currentPhotoMenu, { text: "Текстовый экран" }, keyboard);

    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "deleteMessage",
      "editMessageReplyMarkup",
    ]);
    expect(calls[2]?.args).toEqual([41, 11, { reply_markup: { inline_keyboard: [] } }]);
  });

  it("does not delete the old menu when replacement delivery fails", async () => {
    const { api, calls, failNext } = createApi();
    failNext("sendMessage", new Error("send failed"));

    await expect(presentMenu(api, 41, currentPhotoMenu, { text: "Текстовый экран" }, keyboard))
      .rejects.toThrow("send failed");
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  });

  it("treats message is not modified as a no-op without a duplicate send", async () => {
    const { api, calls, failNext } = createApi();
    failNext("editMessageText", telegramError("Bad Request: message is not modified", "editMessageText"));

    await expect(presentMenu(api, 41, currentTextMenu, { text: "Каталог" }, keyboard))
      .resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
  });

  it("propagates other Telegram edit failures without sending a duplicate menu", async () => {
    const { api, calls, failNext } = createApi();
    failNext("editMessageText", telegramError("Bad Request: message can't be edited", "editMessageText"));

    await expect(presentMenu(api, 41, currentTextMenu, { text: "Каталог" }, keyboard))
      .rejects.toThrow("Bad Request: message can't be edited");
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
  });

  it("sends long caption text after the photo and attaches keyboard only to its last chunk", async () => {
    const { api, calls } = createApi();
    const text = "📜".repeat(1025);

    await presentMenu(api, 41, undefined, {
      imageUrl: "https://assets.example/quest.jpg",
      text,
    }, keyboard);

    expect(calls[0]).toMatchObject({ method: "sendPhoto", args: [41, "https://assets.example/quest.jpg"] });
    const textCalls = calls.filter((call) => call.method === "sendMessage");
    expect(textCalls.map((call) => call.args[1]).join("")).toBe(text);
    const lastMarkup = textCalls.at(-1)?.args[2] as { reply_markup?: InlineKeyboardMarkup };
    const lastButton = lastMarkup.reply_markup?.inline_keyboard[0]?.[0];
    expect(lastButton).toMatchObject({ text: "Открыть" });
    expect(lastButton !== undefined && "callback_data" in lastButton
      ? lastButton.callback_data
      : "").toBe("q2:open");
    expect(textCalls.slice(0, -1).every((call) => call.args[2] === undefined)).toBe(true);
  });

  it("tracks a long photo menu and transitions from its callback message", async () => {
    const { api, calls } = createApi();
    const longView = {
      imageUrl: "https://assets.example/long-menu.jpg",
      text: "📜".repeat(1025),
    };
    await presentMenu(api, 41, undefined, longView, keyboard);
    const photo = calls.find((call) => call.method === "sendPhoto");
    const photoMessageId = Number((photo?.result as { message_id: number }).message_id);
    const textMessage = calls.filter((call) => call.method === "sendMessage").at(-1);
    const markup = textMessage?.args[2] as { reply_markup?: InlineKeyboardMarkup };
    const button = markup.reply_markup?.inline_keyboard[0]?.[0];
    const callbackData = button !== undefined && "callback_data" in button
      ? button.callback_data
      : undefined;
    expect(callbackData).toBe("q2:open");
    const textMessageId = Number((textMessage?.result as { message_id: number }).message_id);
    const current = getExistingMenuMessage(41, textMessageId, false, callbackData);
    expect(resolveMenuCallbackData(callbackData)).toBe("q2:open");
    expect(current).toMatchObject({
      messageId: photoMessageId,
      hasPhoto: true,
      callbackMessageId: textMessageId,
    });
    if (current === undefined) {
      throw new Error("The long photo menu was not tracked.");
    }

    const firstNewCall = calls.length;
    await presentMenu(api, 41, current, { text: "Новый текстовый экран" }, keyboard);
    expect(calls.slice(firstNewCall).map((call) => call.method)).toEqual([
      "sendMessage",
      "deleteMessage",
      "deleteMessage",
    ]);
    expect(calls.slice(firstNewCall + 1).map((call) => call.args[1]))
      .toEqual([photoMessageId, textMessageId]);

    const secondMenu = calls.find((call) => call.method === "sendMessage" &&
      call.args[1] === "Новый текстовый экран");
    const secondMessageId = Number((secondMenu?.result as { message_id: number }).message_id);
    const secondTransitionStart = calls.length;
    const secondMarkup = secondMenu?.args[2] as { reply_markup?: InlineKeyboardMarkup };
    const secondButton = secondMarkup.reply_markup?.inline_keyboard[0]?.[0];
    const secondCallbackData = secondButton !== undefined && "callback_data" in secondButton
      ? secondButton.callback_data
      : undefined;
    const secondCurrent = getExistingMenuMessage(41, secondMessageId, false, secondCallbackData);
    await presentMenu(api, 41, secondCurrent, {
      imageUrl: "https://assets.example/next-photo.jpg",
      text: "Следующее фото",
    }, keyboard);
    expect(calls.slice(secondTransitionStart).map((call) => call.method)).toEqual([
      "editMessageMedia",
    ]);
    expect(calls.at(-1)?.args[2]).toMatchObject({
      media: "https://assets.example/next-photo.jpg",
      caption: "Следующее фото",
    });
  });

  it("tracks every fragment of a photo menu longer than 4096 code points", async () => {
    const { api, calls } = createApi();
    await presentMenu(api, 41, undefined, {
      imageUrl: "https://assets.example/long-menu.jpg",
      text: "📜".repeat(4097),
    }, keyboard);
    const photo = calls.find((call) => call.method === "sendPhoto");
    const photoId = Number((photo?.result as { message_id: number }).message_id);
    const oldTexts = calls.filter((call) => call.method === "sendMessage");
    const callbackMessage = oldTexts.at(-1);
    const callbackId = Number((callbackMessage?.result as { message_id: number }).message_id);
    const markup = callbackMessage?.args[2] as { reply_markup?: InlineKeyboardMarkup };
    const button = markup.reply_markup?.inline_keyboard[0]?.[0];
    const callbackData = button !== undefined && "callback_data" in button
      ? button.callback_data
      : undefined;
    const current = getExistingMenuMessage(41, callbackId, false, callbackData);
    expect(current?.messageIds).toEqual([
      photoId,
      ...oldTexts.map((call) => Number((call.result as { message_id: number }).message_id)),
    ]);

    const firstNewCall = calls.length;
    if (current === undefined) {
      throw new Error("The composite photo menu was not tracked.");
    }
    await presentMenu(api, 41, current, { text: "Теперь только текст." }, keyboard);
    expect(calls.slice(firstNewCall).map((call) => call.method)).toEqual([
      "sendMessage",
      "deleteMessage",
      "deleteMessage",
      "deleteMessage",
    ]);
    expect(calls.slice(firstNewCall + 1).map((call) => call.args[1])).toEqual(current.messageIds);
  });

  it("sends a replacement instead of editing an incomplete screen from another process", async () => {
    const textApi = createApi();
    const untrackedText = getExistingMenuMessage(91, 701, false, "q2:old");
    expect(untrackedText?.complete).toBe(false);
    if (untrackedText === undefined) {
      throw new Error("An untracked callback message was not represented.");
    }

    await presentMenu(textApi.api, 91, untrackedText, { text: "Свежий экран" }, keyboard);
    expect(textApi.calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "editMessageReplyMarkup",
    ]);
    expect(textApi.calls[1]?.args).toEqual([91, 701, { reply_markup: { inline_keyboard: [] } }]);

    const photoApi = createApi();
    const untrackedComposite = getExistingMenuMessage(92, 702, false, "q2:old");
    if (untrackedComposite === undefined) {
      throw new Error("An untracked composite callback message was not represented.");
    }
    await presentMenu(photoApi.api, 92, untrackedComposite, {
      imageUrl: "https://assets.example/replacement.jpg",
      text: "📜".repeat(1025),
    }, keyboard);
    expect(photoApi.calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "sendMessage",
      "editMessageReplyMarkup",
    ]);
    expect(photoApi.calls[0]?.args[1]).toBe("https://assets.example/replacement.jpg");
    expect(photoApi.calls[2]?.args[1]).toBe(702);
  });

  it("reuses a photo callback message when its complete screen is known from Telegram", async () => {
    const { api, calls } = createApi();
    const untrackedPhoto = getExistingMenuMessage(93, 703, true, "q2:old");
    expect(untrackedPhoto?.complete).toBe(true);
    if (untrackedPhoto === undefined) {
      throw new Error("A photo callback message was not represented.");
    }

    await presentMenu(api, 93, untrackedPhoto, {
      imageUrl: "https://assets.example/updated.jpg",
      text: "Карточка",
    }, keyboard);
    expect(calls.map((call) => call.method)).toEqual(["editMessageMedia"]);
    expect(calls[0]?.args[1]).toBe(703);
  });

  it("preserves 64-byte callbacks without process-local resolution", async () => {
    const { api, calls } = createApi();
    const longKeyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Открыть", callback_data: "x".repeat(64) }]],
    };
    await presentMenu(api, 41, undefined, {
      imageUrl: "https://assets.example/long-menu.jpg",
      text: "📜".repeat(1025),
    }, longKeyboard);
    const callbackMessage = calls.filter((call) => call.method === "sendMessage").at(-1);
    const callbackId = Number((callbackMessage?.result as { message_id: number }).message_id);
    const markup = callbackMessage?.args[2] as { reply_markup?: InlineKeyboardMarkup };
    const button = markup.reply_markup?.inline_keyboard[0]?.[0];
    const callbackData = button !== undefined && "callback_data" in button
      ? button.callback_data
      : undefined;
    expect(callbackData).toBe("x".repeat(64));
    expect(resolveMenuCallbackData(callbackData)).toBe("x".repeat(64));
    expect(getExistingMenuMessage(41, callbackId, false, callbackData)).toMatchObject({
      hasPhoto: true,
      callbackMessageId: callbackId,
    });
  });

  it("keeps equal message IDs from separate chats isolated", async () => {
    function apiWithIds(photoId: number): { api: MenuTelegramApi; callbackData: string[] } {
      const callbackData: string[] = [];
      const capture = (other: unknown): void => {
        if (typeof other !== "object" || other === null || !("reply_markup" in other)) {
          return;
        }
        const markup = other.reply_markup as InlineKeyboardMarkup;
        const button = markup.inline_keyboard[0]?.[0];
        if (button !== undefined && "callback_data" in button) {
          callbackData.push(button.callback_data);
        }
      };
      const api: MenuTelegramApi = {
        sendPhoto: async (_chatId, _photo, other) => {
          capture(other);
          return { message_id: photoId };
        },
        sendMessage: async (_chatId, _text, other) => {
          capture(other);
          return { message_id: 900 };
        },
        editMessageText: async () => true,
        editMessageMedia: async () => true,
        deleteMessage: async () => true,
        editMessageReplyMarkup: async () => true,
      };
      return { api, callbackData };
    }
    const longCallbackKeyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Continue", callback_data: "x".repeat(64) }]],
    };
    const view = {
      imageUrl: "https://assets.example/menu.jpg",
      text: "📜".repeat(1025),
    };
    const first = apiWithIds(700);
    const second = apiWithIds(800);
    await presentMenu(first.api, 41, undefined, view, longCallbackKeyboard);
    await presentMenu(second.api, 84, undefined, view, longCallbackKeyboard);

    expect(resolveMenuCallbackData(first.callbackData[0])).toBe("x".repeat(64));
    expect(resolveMenuCallbackData(second.callbackData[0])).toBe("x".repeat(64));
    expect(getExistingMenuMessage(41, 900, false, first.callbackData[0])?.messageId).toBe(700);
    expect(getExistingMenuMessage(84, 900, false, second.callbackData[0])?.messageId).toBe(800);
  });

  it("checks the callback against the message keyboard without local aliases", async () => {
    const { api, calls } = createApi();
    const firstKeyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Первый", callback_data: "q2:first" }]],
    };
    const secondKeyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Второй", callback_data: "q2:second" }]],
    };
    await presentMenu(api, 73, undefined, { text: "Экран 1" }, firstKeyboard);
    const firstCall = calls[0];
    const messageId = Number((firstCall?.result as { message_id: number }).message_id);
    const firstMarkup = firstCall?.args[2] as { reply_markup?: InlineKeyboardMarkup };
    const firstButton = firstMarkup.reply_markup?.inline_keyboard[0]?.[0];
    const firstData = firstButton !== undefined && "callback_data" in firstButton
      ? firstButton.callback_data
      : undefined;
    const firstScreen = getExistingMenuMessage(73, messageId, false, firstData);
    if (firstScreen === undefined) {
      throw new Error("The first screen was not tracked.");
    }

    await presentMenu(api, 73, firstScreen, { text: "Экран 2" }, secondKeyboard);
    const secondCall = calls.at(-1);
    const secondMarkup = secondCall?.args[3] as { reply_markup?: InlineKeyboardMarkup };
    const secondButton = secondMarkup.reply_markup?.inline_keyboard[0]?.[0];
    const secondData = secondButton !== undefined && "callback_data" in secondButton
      ? secondButton.callback_data
      : undefined;

    const currentMarkup = secondMarkup.reply_markup;
    expect(firstData).toBe("q2:first");
    expect(secondData).toBe("q2:second");
    expect(resolveMenuCallbackData(firstData, currentMarkup)).toBeNull();
    expect(resolveMenuCallbackData(secondData, currentMarkup)).toBe("q2:second");
    expect(resolveMenuCallbackData("q2:second")).toBe("q2:second");
  });

  it("keeps menu callbacks usable after bounded local state eviction", async () => {
    const { api, calls } = createApi();
    const longKeyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Continue", callback_data: "x".repeat(64) }]],
    };
    let firstCallbackData: string | undefined;
    let latestCallbackData: string | undefined;
    for (let index = 0; index < 513; index += 1) {
      await presentMenu(api, 10_000 + index, undefined, { text: `Экран ${index}` }, longKeyboard);
      const call = calls.at(-1);
      const markup = call?.args[2] as { reply_markup?: InlineKeyboardMarkup };
      const button = markup.reply_markup?.inline_keyboard[0]?.[0];
      const data = button !== undefined && "callback_data" in button
        ? button.callback_data
        : undefined;
      if (index === 0) {
        firstCallbackData = data;
      }
      latestCallbackData = data;
    }

    expect(resolveMenuCallbackData(firstCallbackData)).toBe("x".repeat(64));
    expect(resolveMenuCallbackData(latestCallbackData)).toBe("x".repeat(64));
  });
});
