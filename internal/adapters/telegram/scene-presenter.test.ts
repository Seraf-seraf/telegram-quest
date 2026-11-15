import { describe, expect, it, vi } from "vitest";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  sendScene,
  splitSceneText,
  type SceneTelegramApi,
} from "./scene-presenter.js";

function createApi(): {
  api: SceneTelegramApi;
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageDraft: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(async (
    _chatId: number | string,
    _text: string,
    _other?: { reply_markup: InlineKeyboardMarkup },
  ) => ({ message_id: 1 }));
  const sendMessageDraft = vi.fn(async (
    _chatId: number,
    _draftId: number,
    _text: string,
  ) => true);
  return {
    api: { sendMessage, sendMessageDraft },
    sendMessage,
    sendMessageDraft,
  };
}

describe("private scene presenter", () => {
  it("keeps short scenes intact and splits long Unicode text on code-point boundaries", () => {
    const shortText = "A 😀 story with *literal* <tags>";
    expect(splitSceneText(shortText)).toEqual([shortText]);
    const nearLimitText = "x".repeat(4096);
    expect(splitSceneText(nearLimitText)).toEqual([nearLimitText]);
    expect(splitSceneText("")).toEqual([]);

    const longText = `${"x".repeat(3899)}😀${"y😀".repeat(2200)}`;
    const chunks = splitSceneText(longText);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(longText);
    expect(chunks.every((chunk) => [...chunk].length <= 3900)).toBe(true);
  });

  it("shows bounded previews and always persists each complete scene chunk", async () => {
    const { api, sendMessage, sendMessageDraft } = createApi();
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Continue", callback_data: "v1:m" }]],
    };
    const text = "A *literal* <scene> 😀";

    await sendScene(api, 41, text, 52, keyboard);

    expect(sendMessageDraft).toHaveBeenCalledTimes(3);
    const codePoints = [...text];
    expect(sendMessageDraft.mock.calls.map((call) => call[2])).toEqual(
      [7, 14, codePoints.length].map((length) => codePoints.slice(0, length).join("")),
    );
    expect(sendMessage).toHaveBeenCalledWith(41, text, { reply_markup: keyboard });
    expect(sendMessage.mock.calls.map((call) => call[1]).join("")).toBe(text);
  });

  it("persists the final scene when a draft preview fails", async () => {
    const { api, sendMessage, sendMessageDraft } = createApi();
    sendMessageDraft.mockRejectedValueOnce(new Error("Draft is unavailable."));
    const text = "The permanent final scene.";

    await expect(sendScene(api, 41, text, 77)).resolves.toBeUndefined();

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(41, text);
  });

  it("sends every long-scene chunk and attaches choices only to the final chunk", async () => {
    const { api, sendMessage, sendMessageDraft } = createApi();
    const text = `${"🧭".repeat(3900)}x${"Ж".repeat(2100)}`;
    const chunks = splitSceneText(text);
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Continue", callback_data: "v1:m" }]],
    };

    await sendScene(api, 41, text, 91, keyboard);

    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual(chunks);
    expect(sendMessage.mock.calls.slice(0, -1).every((call) => call[2] === undefined)).toBe(true);
    expect(sendMessage.mock.calls.at(-1)?.[2]).toEqual({ reply_markup: keyboard });
    expect(sendMessageDraft).toHaveBeenCalledTimes(chunks.length * 3);
  });

  it("does not send an empty scene but still presents its choices", async () => {
    const { api, sendMessage, sendMessageDraft } = createApi();
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "Continue", callback_data: "v1:m" }]],
    };

    await sendScene(api, 41, "", 88, keyboard);

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      41,
      "Выберите действие.",
      { reply_markup: keyboard },
    );
  });
});
