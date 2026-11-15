import { createClient, type Transaction } from "@libsql/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlExecutor, SqlRow, TursoDatabase } from "../turso/client.js";
import { ensureSchema } from "../turso/migrate.js";
import { compileInkStory } from "../ink/compiler.js";
import { initializeApp } from "../../bootstrap.js";
import { registerPrivateQuestHandlers } from "./private-quest.js";
import { encodePrivateQuestCallback } from "./callbacks.js";
import { resolveMenuCallbackData } from "./menu-presenter.js";

const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "test-token",
};
const privateUserId = 41;
const FILE_DATABASE_FLOW_TIMEOUT_MS = 15_000;
const openDatabases = new Set<TursoDatabase>();
const temporaryDirectories: string[] = [];
let nextTelegramMessageId = 100;

interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
  responseMessageId?: number;
}

function createDatabase(url: string): TursoDatabase {
  const client = createClient({ url, concurrency: 1 });
  let closed = false;

  function executorFor(connection: ReturnType<typeof createClient> | Transaction): SqlExecutor {
    return {
      all: async (sql, ...args): Promise<SqlRow[]> => {
        const result = await connection.execute({ sql, args: [...args] });
        return result.rows as unknown as SqlRow[];
      },
      exec: async (sql): Promise<void> => {
        await connection.executeMultiple(sql);
      },
      get: async (sql, ...args): Promise<SqlRow | undefined> => {
        const result = await connection.execute({ sql, args: [...args] });
        return result.rows[0] as unknown as SqlRow | undefined;
      },
      run: async (sql, ...args): Promise<void> => {
        await connection.execute({ sql, args: [...args] });
      },
    };
  }

  const database: TursoDatabase = {
    close(): void {
      if (!closed) {
        client.close();
        closed = true;
      }
    },
    read<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("Local test database is closed.");
      }
      return operation(executorFor(client));
    },
    async write<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("Local test database is closed.");
      }
      const transaction = await client.transaction("write");
      try {
        const result = await operation(executorFor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        if (!transaction.closed) {
          await transaction.rollback();
        }
        throw error;
      } finally {
        transaction.close();
      }
    },
  };

  openDatabases.add(database);
  return database;
}

function createMemoryDatabase(): TursoDatabase {
  return createDatabase("file::memory:");
}

async function createFileDatabase(): Promise<{ database: TursoDatabase; url: string }> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-quest-private-"));
  temporaryDirectories.push(directory);
  const url = `file:${join(directory, "quest.db")}`;
  return { database: createDatabase(url), url };
}

async function compileTaggedStory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-quest-story-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "story.ink"), [
    "-> start",
    "=== start",
    "The tagged opening. # asset:opening_art",
    "+ [Continue]",
    "    -> ending",
    "=== ending",
    "The tagged ending. # asset:ending_art",
    "-> END",
    "",
  ].join("\n"), "utf8");
  return compileInkStory(directory);
}

afterEach(async () => {
  for (const database of openDatabases) {
    database.close();
  }
  openDatabases.clear();
  await Promise.all(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
  temporaryDirectories.length = 0;
});

function createTelegramApiMock(): {
  fetch: typeof fetch;
  calls: TelegramCall[];
  failNext: (method: string) => void;
} {
  const calls: TelegramCall[] = [];
  const failedMethods: string[] = [];

  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = new URL(url).pathname.split("/").at(-1) ?? "";
    const body = init?.body;
    let bodyText: string;
    if (typeof body === "string") {
      bodyText = body;
    } else if (body instanceof URLSearchParams) {
      bodyText = body.toString();
    } else if (input instanceof Request) {
      bodyText = await input.clone().text();
    } else {
      bodyText = "{}";
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      payload = Object.fromEntries(new URLSearchParams(bodyText));
    }
    let responseMessageId: number | undefined;
    const result: unknown = [
      "answerCallbackQuery",
      "editMessageReplyMarkup",
      "sendMessageDraft",
      "deleteMessage",
    ].includes(method)
      ? true
      : (() => {
        responseMessageId = typeof payload.message_id === "number"
          ? payload.message_id
          : nextTelegramMessageId++;
        return {
          message_id: responseMessageId,
          date: 1,
          chat: {
            id: Number(payload.chat_id ?? privateUserId),
            type: "private",
            first_name: "Test user",
          },
          from: {
            id: 1,
            is_bot: true,
            first_name: "Quest bot",
            username: "quest_test_bot",
          },
          ...(typeof payload.text === "string" ? { text: payload.text } : {}),
          ...(method === "sendPhoto" || method === "editMessageMedia"
            ? { photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 1, height: 1 }] }
            : {}),
        };
      })();
    calls.push({ method, payload, responseMessageId });

    const failedMethodIndex = failedMethods.indexOf(method);
    if (failedMethodIndex !== -1) {
      failedMethods.splice(failedMethodIndex, 1);
      return new Response(JSON.stringify({
        ok: false,
        error_code: 500,
        description: "Telegram API unavailable.",
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  return { fetch, calls, failNext: (method) => failedMethods.push(method) };
}

function createTestBot(fetch: typeof globalThis.fetch): Bot {
  return new Bot("123456:fake-bot-token", {
    client: { fetch },
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Quest bot",
      username: "quest_test_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
}

function user(id: number): { id: number; is_bot: false; first_name: string } {
  return { id, is_bot: false, first_name: "Quest player" };
}

function commandUpdate(updateId: number, userId: number, text: string): Update {
  const command = text.split(/\s/, 1)[0] ?? text;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: userId, type: "private", first_name: "Quest player" },
      from: user(userId),
      text,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  };
}

function groupCommandUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: -10041, type: "supergroup", title: "Not a private game" },
      from: user(privateUserId),
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  };
}

function callbackUpdate(
  updateId: number,
  userId: number,
  messageId: number,
  data: string,
  messageKind: "text" | "photo" = "text",
): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: user(userId),
      chat_instance: "private-chat",
      message: {
        message_id: messageId,
        date: 1,
        chat: { id: userId, type: "private", first_name: "Quest player" },
        from: { id: 1, is_bot: true, first_name: "Quest bot", username: "quest_test_bot" },
        reply_markup: { inline_keyboard: [[{ text: "Action", callback_data: data }]] },
        ...(messageKind === "photo"
          ? { photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 1, height: 1 }] }
          : { text: "Current menu" }),
      },
      data,
    },
  };
}

function latestScreen(calls: TelegramCall[]): TelegramCall {
  const screen = calls.filter((call) =>
    ["sendMessage", "sendPhoto", "editMessageText", "editMessageMedia", "editMessageCaption"]
      .includes(call.method)).at(-1);
  if (screen === undefined) {
    throw new Error("No Telegram screen was sent.");
  }
  return screen;
}

function buttonData(calls: TelegramCall[], text: string): string {
  const screen = latestScreen(calls);
  const markup = screen.payload.reply_markup as {
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
  } | undefined;
  const button = markup?.inline_keyboard?.flat().find((item) => item.text === text);
  if (button?.callback_data === undefined) {
    throw new Error(`Callback button ${text} was not found.`);
  }
  return button.callback_data;
}

function buttonDataForMessage(
  calls: TelegramCall[],
  messageId: number,
  text: string,
): string {
  const screen = calls.filter((call) =>
    ["sendMessage", "sendPhoto", "editMessageText", "editMessageMedia", "editMessageCaption"]
      .includes(call.method) &&
    (call.responseMessageId === messageId || Number(call.payload.message_id) === messageId)
  ).at(-1);
  const markup = screen?.payload.reply_markup as {
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
  } | undefined;
  const button = markup?.inline_keyboard?.flat().find((item) => item.text === text);
  if (button?.callback_data === undefined) {
    throw new Error(`Callback button ${text} was not found for message ${messageId}.`);
  }
  return button.callback_data;
}

function latestMessageId(calls: TelegramCall[]): number {
  const screen = latestScreen(calls);
  return screen.responseMessageId ?? Number(screen.payload.message_id);
}

describe("private quest Telegram handlers", () => {
  it("keeps personal commands private and creates recoverable owner sessions", async () => {
    const database = createMemoryDatabase();
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
    });
    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    const failures: Array<{ event: string; phase: string; code: string }> = [];
    const getApplication = vi.fn(async () => app);
    registerPrivateQuestHandlers(bot, getApplication, (event) => failures.push(event));

    await bot.handleUpdate(commandUpdate(1, privateUserId, "/start"));
    expect(latestScreen(telegram.calls).payload.text).toBe("Личный квест. Выберите действие.");
    let messageId = latestMessageId(telegram.calls);

    await bot.handleUpdate(callbackUpdate(
      2,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Квесты"),
    ));
    await bot.handleUpdate(callbackUpdate(
      3,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Две двери"),
    ));
    await bot.handleUpdate(callbackUpdate(
      5,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Начать прохождение"),
    ));
    expect(latestScreen(telegram.calls).payload.text).toBe("A sign points toward two doors.\n");

    const firstSessionPage = await app.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    );
    expect(firstSessionPage.sessions).toHaveLength(1);
    expect(firstSessionPage.sessions[0]).toMatchObject({
      questTitle: "Две двери",
      status: "active",
      stateVersion: 1,
    });

    await bot.handleUpdate(commandUpdate(6, privateUserId, "/quests"));
    messageId = latestMessageId(telegram.calls);
    await bot.handleUpdate(callbackUpdate(
      7,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Две двери"),
    ));
    await bot.handleUpdate(callbackUpdate(
      9,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Начать прохождение"),
    ));
    expect((await app.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions).toHaveLength(2);

    const firstSessionId = firstSessionPage.sessions[0]?.id;
    if (firstSessionId === undefined) {
      throw new Error("The first session was not created.");
    }
    const callsBeforeForeignSession = telegram.calls.length;
    await bot.handleUpdate(callbackUpdate(
      10,
      84,
      999_999,
      encodePrivateQuestCallback({ kind: "session", sessionId: firstSessionId }),
    ));
    expect(latestScreen(telegram.calls).payload.text)
      .toBe("Не удалось выполнить действие. Откройте /menu и попробуйте ещё раз.");
    expect(failures).toContainEqual({
      event: "telegram_quest.private_handler_failed",
      phase: "session_open",
      code: "FORBIDDEN_OWNER",
    });
    expect(JSON.stringify(telegram.calls.slice(callsBeforeForeignSession)))
      .not.toContain("Две двери");

    await bot.handleUpdate(commandUpdate(11, privateUserId, "/sessions"));
    expect(latestScreen(telegram.calls).payload.text).toBe("Ваши личные прохождения:");
    await bot.handleUpdate(callbackUpdate(
      12,
      privateUserId,
      latestMessageId(telegram.calls),
      buttonData(telegram.calls, "Две двери · в процессе"),
    ));
    expect(latestScreen(telegram.calls).payload.text).toBe("A sign points toward two doors.\n");

    const callsBeforeOtherUser = telegram.calls.length;
    await bot.handleUpdate(commandUpdate(13, 84, "/sessions"));
    expect(latestScreen(telegram.calls).payload.text).toBe("Личных прохождений пока нет.");
    expect(JSON.stringify(telegram.calls.slice(callsBeforeOtherUser))).not.toContain("Две двери");

    const callsBeforeGroup = telegram.calls.length;
    const readyCallsBeforeGroup = getApplication.mock.calls.length;
    await bot.handleUpdate(groupCommandUpdate(14));
    expect(telegram.calls).toHaveLength(callsBeforeGroup);
    expect(getApplication).toHaveBeenCalledTimes(readyCallsBeforeGroup);
  });

  it("answers malformed and group callbacks without loading application state", async () => {
    const database = createMemoryDatabase();
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
    });
    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    const getApplication = vi.fn(async () => app);
    registerPrivateQuestHandlers(bot, getApplication);

    await bot.handleUpdate(callbackUpdate(1, privateUserId, 1, "bad:payload"));
    expect(getApplication).not.toHaveBeenCalled();
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery"))
      .toHaveLength(1);

    await bot.handleUpdate(callbackUpdate(
      2,
      privateUserId,
      1,
      "v1:s:bWlzc2luZy12ZXJzaW9u",
    ));
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text)
      .toBe("Меню обновилось. Откройте /menu");
    expect((await app.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions).toEqual([]);

    const readyCallsBeforeGroup = getApplication.mock.calls.length;
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "group-callback",
        from: user(privateUserId),
        chat_instance: "group-chat",
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -10041, type: "supergroup", title: "Not a private game" },
          from: { id: 1, is_bot: true, first_name: "Quest bot", username: "quest_test_bot" },
          text: "Group menu",
        },
        data: "v1:q",
      },
    });
    expect(getApplication).toHaveBeenCalledTimes(readyCallsBeforeGroup);
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery"))
      .toHaveLength(3);
  });

  it("shows the empty catalog without offering an unavailable quest", async () => {
    const database = createMemoryDatabase();
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
    });
    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    const getApplication = vi.fn(async () => ({
      catalog: {
        listAvailableQuests: vi.fn(async () => []),
        listQuestsPage: vi.fn(async () => ({ items: [], page: 1, totalItems: 0, totalPages: 0 })),
        listGenresPage: vi.fn(async () => ({ items: [], page: 1, totalItems: 0, totalPages: 0 })),
        resolveGenreKey: vi.fn(async () => null),
        getQuest: app.catalog.getQuest.bind(app.catalog),
      },
      sessions: app.sessions,
      resolveContent: app.resolveContent,
    }));
    registerPrivateQuestHandlers(bot, getApplication);

    await bot.handleUpdate(commandUpdate(1, privateUserId, "/quests"));

    expect(latestScreen(telegram.calls).payload.text).toBe("Доступных квестов пока нет.");
    expect(JSON.stringify(latestScreen(telegram.calls).payload.reply_markup))
      .not.toContain("Две двери");
    expect(buttonData(telegram.calls, "В меню")).toBeDefined();
  });

  it("resolves menu, cover, current-turn, updated image, and final-scene metadata", async () => {
    const database = createMemoryDatabase();
    const storyJson = await compileTaggedStory();
    const longDescription = "🗝️".repeat(600);
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
      storySource: { load: async () => storyJson },
    });
    await database.write(async (executor) => {
      await executor.run(
        `INSERT INTO quest (id, title, description, genre, available, story_json)
         VALUES (?, ?, ?, ?, 1, ?)`,
        "tagged-story",
        "Tagged story",
        longDescription,
        "Test",
        storyJson,
      );
      const metadata = [
        [null, "menu.main.banner", "https://assets.example/main.jpg"],
        [null, "menu.quests.banner", "https://assets.example/quests.jpg"],
        [null, "menu.sessions.banner", "https://assets.example/sessions.jpg"],
        ["tagged-story", "cover", "https://assets.example/cover.jpg"],
        ["tagged-story", "opening_art", "https://assets.example/opening-v1.jpg"],
        ["tagged-story", "ending_art", "https://assets.example/ending.jpg"],
      ] as const;
      for (const [questId, name, value] of metadata) {
        await executor.run(
          `INSERT INTO content_metadata (quest_id, name, kind, value)
           VALUES (?, ?, 'image', ?)`,
          questId,
          name,
          value,
        );
      }
    });

    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    registerPrivateQuestHandlers(bot, async () => app);

    await bot.handleUpdate(commandUpdate(1, privateUserId, "/start"));
    expect(latestScreen(telegram.calls).payload.photo).toBe("https://assets.example/main.jpg");
    expect(latestScreen(telegram.calls).payload.caption).toBe("Личный квест. Выберите действие.");

    await bot.handleUpdate(commandUpdate(2, privateUserId, "/quests"));
    let menuMessageId = latestMessageId(telegram.calls);
    expect(latestScreen(telegram.calls).payload.photo).toBe("https://assets.example/quests.jpg");
    await bot.handleUpdate(callbackUpdate(
      3,
      privateUserId,
      menuMessageId,
      buttonData(telegram.calls, "Tagged story"),
      "photo",
    ));
    expect(telegram.calls.filter((call) => call.method === "editMessageMedia").at(-1)?.payload.media)
      .toMatchObject({ media: "https://assets.example/cover.jpg" });
    const cardMessageId = latestMessageId(telegram.calls);
    expect(latestScreen(telegram.calls).method).toBe("sendMessage");

    await bot.handleUpdate(callbackUpdate(
      4,
      privateUserId,
      cardMessageId,
      buttonDataForMessage(telegram.calls, cardMessageId, "Начать прохождение"),
      "text",
    ));
    expect(telegram.calls.filter((call) => call.method === "deleteMessage")
      .slice(-2).map((call) => Number(call.payload.message_id)))
      .toEqual([menuMessageId, cardMessageId]);
    let sceneMessageId = latestMessageId(telegram.calls);
    expect(latestScreen(telegram.calls).payload.photo).toBe("https://assets.example/opening-v1.jpg");
    expect(latestScreen(telegram.calls).payload.caption).toBe("The tagged opening.\n");

    const applyDecision = vi.spyOn(app.sessions, "applyDecision");
    const owner = { type: "user" as const, id: String(privateUserId) };
    const session = (await app.sessions.listOwnedSessions(owner, 20, null)).sessions[0];
    if (session === undefined) {
      throw new Error("The tagged story session was not created.");
    }
    await database.write((executor) => executor.run(
      `UPDATE content_metadata
          SET value = ?
        WHERE quest_id = ? AND name = ?`,
      "https://assets.example/opening-v2.jpg",
      "tagged-story",
      "opening_art",
    ));

    await bot.handleUpdate(commandUpdate(5, privateUserId, "/sessions"));
    menuMessageId = latestMessageId(telegram.calls);
    expect(latestScreen(telegram.calls).payload.photo).toBe("https://assets.example/sessions.jpg");
    await bot.handleUpdate(callbackUpdate(
      6,
      privateUserId,
      menuMessageId,
      buttonData(telegram.calls, "Tagged story · в процессе"),
      "photo",
    ));
    sceneMessageId = latestMessageId(telegram.calls);
    expect(latestScreen(telegram.calls).payload.photo).toBe("https://assets.example/opening-v2.jpg");

    await bot.handleUpdate(callbackUpdate(
      7,
      privateUserId,
      sceneMessageId,
      buttonDataForMessage(telegram.calls, sceneMessageId, "Continue"),
      "photo",
    ));
    expect(latestScreen(telegram.calls).payload.photo).toBe("https://assets.example/ending.jpg");
    expect(latestScreen(telegram.calls).payload.caption).toBe("The tagged ending.\n");
    expect(applyDecision).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a saved choice or edit/delete its scene when photo delivery fails", async () => {
    const database = createMemoryDatabase();
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
    });
    vi.spyOn(app, "resolveContent").mockImplementation(async (questId, text) =>
      questId === null ? { text } : { text, imageUrl: "https://assets.example/scene.jpg" }
    );
    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    const failures: Array<{ event: string; phase: string; code: string }> = [];
    registerPrivateQuestHandlers(bot, async () => app, (event) => failures.push(event));

    await bot.handleUpdate(commandUpdate(10, privateUserId, "/quests"));
    const menuMessageId = latestMessageId(telegram.calls);
    await bot.handleUpdate(callbackUpdate(
      11,
      privateUserId,
      menuMessageId,
      buttonData(telegram.calls, "Две двери"),
    ));
    await bot.handleUpdate(callbackUpdate(
      12,
      privateUserId,
      menuMessageId,
      buttonData(telegram.calls, "Начать прохождение"),
    ));
    const sceneMessageId = latestMessageId(telegram.calls);
    const choice = buttonDataForMessage(telegram.calls, sceneMessageId, "Take the left path");
    const applyDecision = vi.spyOn(app.sessions, "applyDecision");
    telegram.failNext("sendPhoto");

    await bot.handleUpdate(callbackUpdate(
      13,
      privateUserId,
      sceneMessageId,
      choice,
      "photo",
    ));

    expect(applyDecision).toHaveBeenCalledTimes(1);
    expect(latestScreen(telegram.calls).payload.text)
      .toBe("Ход сохранён. Откройте /sessions, чтобы восстановить продолжение.");
    expect(telegram.calls.some((call) =>
      call.method === "deleteMessage" && Number(call.payload.message_id) === sceneMessageId
    )).toBe(false);
    expect(telegram.calls.some((call) =>
      call.method === "editMessageText" && Number(call.payload.message_id) === sceneMessageId
    )).toBe(false);
    expect(failures).toContainEqual({
      event: "telegram_quest.private_handler_failed",
      phase: "scene",
      code: "INTERNAL_ERROR",
    });

    await bot.handleUpdate(callbackUpdate(14, privateUserId, sceneMessageId, choice, "photo"));
    expect(applyDecision).toHaveBeenCalledTimes(1);
  });

  it("plays both real Ink branches, rejects stale choices, and recovers after app restart", async () => {
    const temporary = await createFileDatabase();
    const firstDatabase = temporary.database;
    let application = await initializeApp(validEnv, {
      createDatabase: () => firstDatabase,
      ensureSchema,
      logFailure: () => undefined,
    });
    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    const failures: Array<{ event: string; phase: string; code: string }> = [];
    const getApplication = vi.fn(async () => application);
    registerPrivateQuestHandlers(bot, getApplication, (event) => failures.push(event));

    async function startQuest(
      userId: number,
      firstUpdateId: number,
      failSceneSend: boolean,
    ): Promise<{ sceneMessageId: number | null }> {
      await bot.handleUpdate(commandUpdate(firstUpdateId, userId, "/quests"));
      const panelMessageId = latestMessageId(telegram.calls);
      await bot.handleUpdate(callbackUpdate(
        firstUpdateId + 1,
        userId,
        panelMessageId,
        buttonData(telegram.calls, "Две двери"),
      ));
      if (failSceneSend) {
        telegram.failNext("sendMessage");
      }
      await bot.handleUpdate(callbackUpdate(
        firstUpdateId + 3,
        userId,
        panelMessageId,
        buttonData(telegram.calls, "Начать прохождение"),
      ));
      const screen = latestScreen(telegram.calls);
      return {
        sceneMessageId: screen.method === "sendMessage" ? screen.responseMessageId ?? null : null,
      };
    }

    await startQuest(privateUserId, 100, true);
    expect(latestScreen(telegram.calls).payload.text)
      .toBe("Не удалось выполнить действие. Откройте /menu и попробуйте ещё раз.");
    expect((await application.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions).toMatchObject([{ status: "active", stateVersion: 1 }]);

    firstDatabase.close();
    const recoveredDatabase = createDatabase(temporary.url);
    application = await initializeApp(validEnv, {
      createDatabase: () => recoveredDatabase,
      ensureSchema,
      logFailure: () => undefined,
    });
    const applyDecision = vi.spyOn(application.sessions, "applyDecision");

    await bot.handleUpdate(commandUpdate(104, privateUserId, "/sessions"));
    const sessionsPanelId = latestMessageId(telegram.calls);
    await bot.handleUpdate(callbackUpdate(
      105,
      privateUserId,
      sessionsPanelId,
      buttonData(telegram.calls, "Две двери · в процессе"),
    ));
    expect(latestScreen(telegram.calls).payload.text).toBe("A sign points toward two doors.\n");
    const firstSessionId = (await application.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions[0]?.id;
    if (firstSessionId === undefined) {
      throw new Error("The saved session was not recovered after app restart.");
    }
    const firstSceneMessageId = latestMessageId(telegram.calls);
    const firstChoiceData = buttonDataForMessage(
      telegram.calls,
      firstSceneMessageId,
      "Take the left path",
    );
    const firstSceneSend = telegram.calls.find((call) =>
      call.method === "sendMessage" && call.payload.text === "A sign points toward two doors.\n"
    );
    expect(firstSceneSend?.payload.parse_mode).toBeUndefined();

    telegram.failNext("sendMessage");
    await bot.handleUpdate(callbackUpdate(
      106,
      privateUserId,
      firstSceneMessageId,
      firstChoiceData,
    ));
    expect(latestScreen(telegram.calls).payload.text)
      .toBe("Ход сохранён. Откройте /sessions, чтобы восстановить продолжение.");
    expect(telegram.calls.filter((call) => call.method === "editMessageReplyMarkup").at(-1)?.payload.reply_markup)
      .toEqual({ inline_keyboard: [] });
    expect(applyDecision).toHaveBeenCalledTimes(1);

    recoveredDatabase.close();
    const restartedDatabase = createDatabase(temporary.url);
    application = await initializeApp(validEnv, {
      createDatabase: () => restartedDatabase,
      ensureSchema,
      logFailure: () => undefined,
    });
    const restartedApplyDecision = vi.spyOn(application.sessions, "applyDecision");
    await bot.handleUpdate(commandUpdate(107, privateUserId, "/sessions"));
    const restartedSessionsPanelId = latestMessageId(telegram.calls);
    await bot.handleUpdate(callbackUpdate(
      108,
      privateUserId,
      restartedSessionsPanelId,
      buttonData(telegram.calls, "Две двери · в процессе"),
    ));
    expect(latestScreen(telegram.calls).payload.text).toContain("The left path glows.");
    const secondSceneMessageId = latestMessageId(telegram.calls);
    const secondChoiceData = buttonDataForMessage(
      telegram.calls,
      secondSceneMessageId,
      "Climb the tower",
    );

    await bot.handleUpdate(callbackUpdate(
      109,
      privateUserId,
      firstSceneMessageId,
      firstChoiceData,
    ));
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text)
      .toBe("Ход изменился. Откройте /sessions, чтобы увидеть продолжение.");
    expect(restartedApplyDecision).not.toHaveBeenCalled();

    await bot.handleUpdate(callbackUpdate(
      110,
      privateUserId,
      secondSceneMessageId,
      secondChoiceData,
    ));
    expect(latestScreen(telegram.calls).payload.text).toBe("The tower door closes.\n");
    expect(restartedApplyDecision).toHaveBeenCalledTimes(1);

    const secondPlayerStart = await startQuest(84, 111, false);
    if (secondPlayerStart.sceneMessageId === null) {
      throw new Error("The second player's opening scene was not sent.");
    }
    const rightChoiceData = buttonDataForMessage(
      telegram.calls,
      secondPlayerStart.sceneMessageId,
      "Take the right path",
    );
    const firstPlayerSession = (await application.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions[0];
    if (firstPlayerSession === undefined) {
      throw new Error("The first player's session is unavailable.");
    }
    const foreignChoice = encodePrivateQuestCallback({
      kind: "choice",
      sessionId: firstPlayerSession.id,
      stateVersion: 1,
      choiceIndex: 1,
    });
    await bot.handleUpdate(callbackUpdate(
      115,
      84,
      secondPlayerStart.sceneMessageId,
      foreignChoice,
    ));
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text)
      .toBe("Ход изменился. Откройте /sessions, чтобы увидеть продолжение.");
    expect(restartedApplyDecision).toHaveBeenCalledTimes(1);

    await bot.handleUpdate(callbackUpdate(
      116,
      84,
      secondPlayerStart.sceneMessageId,
      rightChoiceData,
    ));
    expect(latestScreen(telegram.calls).payload.text).toContain("The right path echoes.");
    const rightSceneMessageId = latestMessageId(telegram.calls);
    await bot.handleUpdate(callbackUpdate(
      117,
      84,
      rightSceneMessageId,
      buttonDataForMessage(telegram.calls, rightSceneMessageId, "Return by the same path"),
    ));
    expect(latestScreen(telegram.calls).payload.text).toBe("The right road reaches the river.\n");
    expect(restartedApplyDecision).toHaveBeenCalledTimes(3);

    expect((await application.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions).toMatchObject([{ id: firstPlayerSession.id, status: "completed" }]);
    expect((await application.sessions.listOwnedSessions(
      { type: "user", id: "84" },
      20,
      null,
    )).sessions).toMatchObject([{ status: "completed" }]);
    expect(failures).toContainEqual({
      event: "telegram_quest.private_handler_failed",
      phase: "scene",
      code: "INTERNAL_ERROR",
    });
  }, FILE_DATABASE_FLOW_TIMEOUT_MS);

  it("confirms lifecycle actions, lists turns, and rejects stale or foreign controls", async () => {
    const database = createMemoryDatabase();
    const app = await initializeApp(validEnv, {
      createDatabase: () => database,
      ensureSchema,
      logFailure: () => undefined,
    });
    const telegram = createTelegramApiMock();
    const bot = createTestBot(telegram.fetch);
    const failures: Array<{ event: string; phase: string; code: string }> = [];
    const getApplication = vi.fn(async () => app);
    registerPrivateQuestHandlers(bot, getApplication, (event) => failures.push(event));
    const pauseSession = vi.spyOn(app.sessions, "pauseSession");
    const resumeSession = vi.spyOn(app.sessions, "resumeSession");
    const stopSession = vi.spyOn(app.sessions, "stopSession");
    const restartSession = vi.spyOn(app.sessions, "restartSession");
    const rewindSession = vi.spyOn(app.sessions, "rewindSession");
    const applyDecision = vi.spyOn(app.sessions, "applyDecision");
    const storyStart = vi.spyOn(app.storyRuntime, "start");
    const storyChoose = vi.spyOn(app.storyRuntime, "choose");
    let updateId = 200;

    await bot.handleUpdate(commandUpdate(190, privateUserId, "/quests"));
    const panelMessageId = latestMessageId(telegram.calls);

    async function clickPanel(text: string, userId: number = privateUserId): Promise<string> {
      const data = buttonDataForMessage(telegram.calls, panelMessageId, text);
      await bot.handleUpdate(callbackUpdate(updateId++, userId, panelMessageId, data));
      return data;
    }

    async function clickCallback(
      messageId: number,
      data: string,
      userId: number = privateUserId,
    ): Promise<void> {
      await bot.handleUpdate(callbackUpdate(updateId++, userId, messageId, data));
    }

    await clickPanel("Две двери");
    await clickPanel("Начать прохождение");
    expect(storyStart).toHaveBeenCalledTimes(1);

    const session = (await app.sessions.listOwnedSessions(
      { type: "user", id: String(privateUserId) },
      20,
      null,
    )).sessions[0];
    if (session === undefined) {
      throw new Error("The test quest session was not created.");
    }
    const initialSession = await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    );
    const initialTurnId = initialSession.turns[0]?.id;
    const initialSceneMessageId = latestMessageId(telegram.calls);
    const initialChoice = buttonDataForMessage(
      telegram.calls,
      initialSceneMessageId,
      "Take the left path",
    );
    const originalManage = buttonDataForMessage(telegram.calls, panelMessageId, "Управление");

    await clickCallback(
      panelMessageId,
      encodePrivateQuestCallback({
        kind: "pause",
        sessionId: session.id,
        stateVersion: 1,
      }),
      84,
    );
    expect(pauseSession).not.toHaveBeenCalled();
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text)
      .toBe("Прохождение изменилось. Откройте /sessions и выберите его снова.");
    expect(failures).toContainEqual({
      event: "telegram_quest.private_handler_failed",
      phase: "session_lifecycle",
      code: "FORBIDDEN_OWNER",
    });

    await clickCallback(initialSceneMessageId, initialChoice);
    expect(applyDecision).toHaveBeenCalledTimes(1);
    expect(storyChoose).toHaveBeenCalledTimes(1);
    expect((await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).stateVersion).toBe(2);

    await clickCallback(panelMessageId, originalManage);
    const pauseCallbackData = buttonDataForMessage(telegram.calls, panelMessageId, "Пауза");
    expect(resolveMenuCallbackData(pauseCallbackData)).toBe(
      encodePrivateQuestCallback({ kind: "pause", sessionId: session.id, stateVersion: 2 }),
    );
    await clickPanel("Пауза");
    expect(pauseSession).toHaveBeenCalledWith(
      { type: "user", id: String(privateUserId) },
      session.id,
      2,
    );
    expect(await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).toMatchObject({ status: "paused", stateVersion: 3 });

    await clickCallback(initialSceneMessageId, initialChoice);
    expect(applyDecision).toHaveBeenCalledTimes(1);
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text)
      .toBe("Ход изменился. Откройте /sessions, чтобы увидеть продолжение.");

    await clickPanel("Управление");
    await clickPanel("Продолжить игру");
    expect(resumeSession).toHaveBeenCalledWith(
      { type: "user", id: String(privateUserId) },
      session.id,
      3,
    );
    expect(await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).toMatchObject({ status: "active", stateVersion: 4 });

    await clickPanel("Управление");
    await clickPanel("История ходов");
    expect(latestScreen(telegram.calls).payload.text).toContain("Ход 1: A sign points toward two doors.");
    expect(latestScreen(telegram.calls).payload.text).toContain("Ход 2: The left path glows.");
    const firstTurnButton = "Ход 1: A sign points toward two doors.";
    await clickPanel(firstTurnButton);
    expect(latestScreen(telegram.calls).payload.text)
      .toContain("Откатиться к ходу 1: A sign points toward two doors.");
    await clickPanel("Отмена");
    expect(rewindSession).not.toHaveBeenCalled();
    expect(await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).toMatchObject({ status: "active", stateVersion: 4 });

    await clickPanel("История ходов");
    await clickPanel(firstTurnButton);
    await clickPanel("Подтвердить откат");
    expect(rewindSession).toHaveBeenCalledWith(
      { type: "user", id: String(privateUserId) },
      session.id,
      1,
      4,
    );
    expect(storyStart).toHaveBeenCalledTimes(1);
    expect(storyChoose).toHaveBeenCalledTimes(1);
    const rewound = await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    );
    expect(rewound).toMatchObject({ status: "active", stateVersion: 5 });
    expect(rewound.turns).toHaveLength(1);
    expect(rewound.turns[0]?.stepNumber).toBe(1);
    expect(rewound.turns[0]?.id).not.toBe(initialTurnId);
    expect(rewindSession).toHaveBeenCalledTimes(1);

    await clickCallback(initialSceneMessageId, initialChoice);
    expect(applyDecision).toHaveBeenCalledTimes(1);
    const currentSceneMessageId = latestMessageId(telegram.calls);
    const currentChoice = buttonDataForMessage(
      telegram.calls,
      currentSceneMessageId,
      "Take the left path",
    );
    const staleManage = buttonDataForMessage(telegram.calls, panelMessageId, "Управление");
    await clickCallback(currentSceneMessageId, currentChoice);
    expect(storyChoose).toHaveBeenCalledTimes(2);
    expect((await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).stateVersion).toBe(6);

    await clickCallback(panelMessageId, staleManage);
    expect(resolveMenuCallbackData(
      buttonDataForMessage(telegram.calls, panelMessageId, "Пауза"),
    )).toBe(
      encodePrivateQuestCallback({ kind: "pause", sessionId: session.id, stateVersion: 6 }),
    );
    await clickPanel("Начать заново");
    expect(latestScreen(telegram.calls).payload.text)
      .toContain("Текущие ходы и выборы будут удалены.");
    await clickPanel("Отмена");
    expect(restartSession).not.toHaveBeenCalled();
    expect((await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).stateVersion).toBe(6);

    await clickPanel("Начать заново");
    await clickPanel("Подтвердить перезапуск");
    expect(restartSession).toHaveBeenCalledWith(
      { type: "user", id: String(privateUserId) },
      session.id,
      6,
      true,
    );
    expect(storyStart).toHaveBeenCalledTimes(2);
    expect(storyChoose).toHaveBeenCalledTimes(2);
    const restarted = await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    );
    expect(restarted).toMatchObject({ status: "active", stateVersion: 7 });
    expect(restarted.turns).toHaveLength(1);
    expect(restarted.turns[0]?.stepNumber).toBe(1);
    expect(restarted.turns[0]?.id).not.toBe(rewound.turns[0]?.id);
    expect(restartSession).toHaveBeenCalledTimes(1);

    await clickPanel("Управление");
    await clickPanel("Остановить");
    await clickPanel("Отмена");
    expect(stopSession).not.toHaveBeenCalled();
    expect((await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    )).stateVersion).toBe(7);

    await clickPanel("Остановить");
    await clickPanel("Подтвердить остановку");
    expect(stopSession).toHaveBeenCalledWith(
      { type: "user", id: String(privateUserId) },
      session.id,
      7,
    );
    const stopped = await app.sessions.getSession(
      { type: "user", id: String(privateUserId) },
      session.id,
    );
    expect(stopped).toMatchObject({
      status: "completed",
      stateVersion: 8,
      outcome: "stopped_by_owner",
      finalScene: null,
    });
    expect(stopSession).toHaveBeenCalledTimes(1);

    await clickCallback(panelMessageId, encodePrivateQuestCallback({
      kind: "rewind_confirm",
      sessionId: session.id,
      stateVersion: stopped.stateVersion,
      targetStepNo: 1,
      confirmed: true,
    }));
    expect(rewindSession).toHaveBeenCalledTimes(1);
    expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text)
      .toBe("Прохождение изменилось. Откройте /sessions и выберите его снова.");
  });
});
