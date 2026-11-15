import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineKeyboardMarkup } from "grammy/types";
import { sendScene, splitSceneText, type SceneTelegramApi } from "./scene-presenter.js";

interface TelegramCall {
  method: string;
  text?: string;
  photo?: string;
  draftId?: number;
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
    sendMessageDraft: async (_chatId, draftId, text) => {
      calls.push({ method: "sendMessageDraft", draftId, text });
    },
  };
  return { api, calls };
}

const keyboard: InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: "Продолжить", callback_data: "q2:next" }]],
};

describe("scene presenter", () => {
  afterEach(() => vi.useRealTimers());

  it("pauses 300 ms after every speech ellipsis unless that line opts out", async () => {
    vi.useFakeTimers();
    const { api, calls } = createApi();
    const text = "- Брат: Да... дальше\nАвторское описание...\n- Герой: Нет… продолжай…\n- Без паузы...";
    const pending = sendScene(api, 41, { text }, 100, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [4],
    });
    await vi.waitFor(() => expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(1));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    const drafts = calls.filter((call) => call.method === "sendMessageDraft");
    expect(drafts.map((call) => call.text)).toEqual([
      "- Брат: Да...",
      "- Брат: Да... дальше\nАвторское описание...\n- Герой: Нет…",
      "- Брат: Да... дальше\nАвторское описание...\n- Герой: Нет… продолжай…",
      text,
    ]);
    const messages = calls.filter((call) => call.method === "sendMessage");
    expect(messages).toEqual([{ method: "sendMessage", text, other: { reply_markup: keyboard } }]);
  });

  it("falls back to one final message when a later draft fails", async () => {
    vi.useFakeTimers();
    const { api, calls } = createApi();
    let draftCalls = 0;
    api.sendMessageDraft = async (_chatId, draftId, text) => {
      draftCalls += 1;
      calls.push({ method: "sendMessageDraft", draftId, text });
      if (draftCalls === 2) {
        throw new Error("draft unavailable");
      }
    };
    const text = "- Брат: Подожди... скажу.";
    const pending = sendScene(api, 41, { text }, 101, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [],
    });
    await vi.waitFor(() => expect(draftCalls).toBe(1));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(2);
    const messages = calls.filter((call) => call.method === "sendMessage");
    expect(messages.map((call) => call.text).join("")).toBe(text);
    expect(messages.at(-1)?.other?.reply_markup).toEqual(keyboard);
    expect(messages.filter((call) => call.other?.reply_markup !== undefined)).toHaveLength(1);
  });

  it("sends a frame first and falls back cleanly when the first draft fails", async () => {
    const { api, calls } = createApi();
    api.sendMessageDraft = async (_chatId, draftId, text) => {
      calls.push({ method: "sendMessageDraft", draftId, text });
      throw new Error("draft unavailable");
    };
    const text = "- Брат: Слушай...";
    await sendScene(api, 41, { imageUrl: "https://assets.example/scene.jpg", text }, 102, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [],
    });
    expect(calls.map((call) => call.method)).toEqual(["sendPhoto", "sendMessageDraft", "sendMessage"]);
    expect(calls.at(-1)).toEqual({ method: "sendMessage", text, other: { reply_markup: keyboard } });
  });

  it("keeps no-pause line numbering across Telegram text chunks", async () => {
    vi.useFakeTimers();
    const { api, calls } = createApi();
    const text = `- ${"а".repeat(4100)}... продолжаю`;
    await sendScene(api, 41, { text }, 103, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [1],
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.filter((call) => call.method === "sendMessageDraft").map((call) => call.text))
      .toEqual([[...text].slice(0, 3900).join(""), [...text].slice(3900).join("")]);
    const messages = calls.filter((call) => call.method === "sendMessage");
    expect(messages.map((call) => call.text).join("")).toBe(text);
    expect(messages.at(-1)?.other?.reply_markup).toEqual(keyboard);
    expect(messages.filter((call) => call.other?.reply_markup !== undefined)).toHaveLength(1);
  });

  it("uses final-message chunk boundaries for previews and falls back from the failing chunk", async () => {
    const { api, calls } = createApi();
    const text = "🧭".repeat(4097);
    let draftCalls = 0;
    api.sendMessageDraft = async (_chatId, draftId, chunk) => {
      draftCalls += 1;
      calls.push({ method: "sendMessageDraft", draftId, text: chunk });
      if (draftCalls === 2) throw new Error("second chunk draft unavailable");
    };
    await sendScene(api, 41, { text }, 105, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [],
    });
    expect(calls.map((call) => call.method)).toEqual([
      "sendMessageDraft", "sendMessage", "sendMessageDraft", "sendMessage",
    ]);
    expect(calls.filter((call) => call.method === "sendMessage").map((call) => call.text).join(""))
      .toBe(text);
    expect(calls.filter((call) => call.method === "sendMessageDraft").map((call) => call.draftId))
      .toEqual([expect.any(Number), expect.any(Number)]);
    expect(calls[0]?.draftId).not.toBe(calls[2]?.draftId);
    expect(calls.at(-1)?.other?.reply_markup).toEqual(keyboard);
    expect(calls.filter((call) => call.other?.reply_markup !== undefined)).toHaveLength(1);
  });

  it("uses one preview ID for a 3901–4096 code-point text block", async () => {
    const { api, calls } = createApi();
    const text = "界".repeat(4000);
    await sendScene(api, 41, { text }, 106, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [],
    });
    expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });

  it("waits after a trailing dialogue ellipsis before sending the final message", async () => {
    vi.useFakeTimers();
    const { api, calls } = createApi();
    const text = "  — брат сказал…";
    const pending = sendScene(api, 41, { text }, 104, keyboard, {
      stream: true,
      replay: false,
      noPauseLines: [],
    });
    await vi.waitFor(() => expect(calls.filter((call) => call.method === "sendMessageDraft")).toHaveLength(1));
    expect(calls.some((call) => call.method === "sendMessage")).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([
      { method: "sendMessage", text, other: { reply_markup: keyboard } },
    ]);
  });

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
