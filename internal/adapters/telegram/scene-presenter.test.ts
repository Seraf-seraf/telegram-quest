import { describe, expect, it } from "vitest";
import type { InlineKeyboardMarkup } from "grammy/types";
import { sendScene, splitSceneText, type SceneTelegramApi } from "./scene-presenter.js";

interface TelegramCall {
  method: string;
  text?: string;
  photo?: string;
  other?: { caption?: string; reply_markup?: InlineKeyboardMarkup };
}

function createApi(): { api: SceneTelegramApi; calls: TelegramCall[] } {
  const calls: TelegramCall[] = [];
  const api: SceneTelegramApi = {
    sendMessage: async (_chatId, text, other) => {
      calls.push({ method: "sendMessage", text, other });
    },
    sendPhoto: async (_chatId, photo, other) => {
      calls.push({ method: "sendPhoto", photo, other });
    },
    sendMessageDraft: async (_chatId, _draftId, text) => {
      calls.push({ method: "sendMessageDraft", text });
    },
  };
  return { api, calls };
}

const keyboard: InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: "Продолжить", callback_data: "q2:next" }]],
};

describe("scene presenter", () => {
  it("sends a photo with a caption of 1024 Unicode code points and its keyboard", async () => {
    const { api, calls } = createApi();
    const caption = "😀".repeat(1024);

    await sendScene(api, 41, { imageUrl: "https://assets.example/scene.jpg", text: caption }, 10, keyboard);

    const photo = calls.find((call) => call.method === "sendPhoto");
    expect(photo).toMatchObject({
      photo: "https://assets.example/scene.jpg",
      other: { caption, reply_markup: keyboard },
    });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
    expect(calls.some((call) => call.other !== undefined && "parse_mode" in call.other)).toBe(false);
  });

  it("sends a 1025-code-point scene as full text after the photo with keyboard last", async () => {
    const { api, calls } = createApi();
    const text = "界".repeat(1025);

    await sendScene(api, 41, { imageUrl: "https://assets.example/scene.jpg", text }, 11, keyboard);

    expect(calls.find((call) => call.method === "sendPhoto")?.other).toBeUndefined();
    const messages = calls.filter((call) => call.method === "sendMessage");
    expect(messages.map((call) => call.text).join("")).toBe(text);
    expect(messages.at(-1)?.other?.reply_markup).toEqual(keyboard);
  });

  it("keeps text intact at 4096 and 4097 Unicode code points", async () => {
    for (const length of [4096, 4097]) {
      const { api, calls } = createApi();
      const text = "🧭".repeat(length);

      await sendScene(api, 41, { text }, 12, keyboard);

      const messages = calls.filter((call) => call.method === "sendMessage");
      expect(messages.map((call) => call.text).join("")).toBe(text);
      expect(messages.every((call) => [...(call.text ?? "")].length <= 4096)).toBe(true);
      expect(messages.at(-1)?.other?.reply_markup).toEqual(keyboard);
      expect(messages.slice(0, -1).every((call) => call.other === undefined)).toBe(true);
    }
  });

  it("sends photo first, then all long text chunks, retaining draft previews", async () => {
    const { api, calls } = createApi();
    const text = "🪵".repeat(4097);

    await sendScene(api, 41, { imageUrl: "https://assets.example/scene.jpg", text }, 13, keyboard);

    expect(calls[0]?.method).toBe("sendPhoto");
    const messages = calls.filter((call) => call.method === "sendMessage");
    expect(messages.map((call) => call.text).join("")).toBe(text);
    expect(messages.every((call) => [...(call.text ?? "")].length <= 4096)).toBe(true);
    expect(messages.at(-1)?.other?.reply_markup).toEqual(keyboard);
    expect(calls.some((call) => call.method === "sendMessageDraft")).toBe(true);
  });

  it("preserves the existing text-only path and draft previews", async () => {
    const { api, calls } = createApi();
    const text = "A saved scene.";

    await sendScene(api, 41, { text }, 14, keyboard);

    expect(calls.some((call) => call.method === "sendPhoto")).toBe(false);
    expect(calls.some((call) => call.method === "sendMessageDraft")).toBe(true);
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([
      { method: "sendMessage", text, other: { reply_markup: keyboard } },
    ]);
    expect(splitSceneText("🧭".repeat(4097)).map((chunk) => [...chunk].length))
      .toEqual([3900, 197]);
  });
});
