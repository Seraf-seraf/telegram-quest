import { createClient, type Transaction } from "@libsql/client";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlExecutor, SqlRow, TursoDatabase } from "../turso/client.js";
import { ensureSchema } from "../turso/migrate.js";
import { initializeApp } from "../../bootstrap.js";
import { registerPrivateQuestHandlers } from "./private-quest.js";
import { encodePrivateQuestCallback } from "./callbacks.js";

const validEnv = {
  TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
  TURSO_AUTH_TOKEN: "test-token",
};
const privateUserId = 41;
const openDatabases = new Set<TursoDatabase>();

interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
  responseMessageId?: number;
}

function createMemoryDatabase(): TursoDatabase {
  const client = createClient({ url: "file::memory:", concurrency: 1 });
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

afterEach(() => {
  for (const database of openDatabases) {
    database.close();
  }
  openDatabases.clear();
});

function createTelegramApiMock(): {
  fetch: typeof fetch;
  calls: TelegramCall[];
  latestSentMessageId: () => number;
} {
  const calls: TelegramCall[] = [];
  let nextMessageId = 100;
  let sentMessageId = 99;

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
    const result: unknown = method === "answerCallbackQuery"
      ? true
      : (() => {
        responseMessageId = typeof payload.message_id === "number"
          ? payload.message_id
          : nextMessageId++;
        if (method === "sendMessage") {
          sentMessageId = responseMessageId;
        }
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
          text: typeof payload.text === "string" ? payload.text : "",
        };
      })();
    calls.push({ method, payload, responseMessageId });

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  return { fetch, calls, latestSentMessageId: () => sentMessageId };
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
        text: "Current menu",
      },
      data,
    },
  };
}

function latestScreen(calls: TelegramCall[]): TelegramCall {
  const screen = calls.filter((call) =>
    call.method === "sendMessage" || call.method === "editMessageText").at(-1);
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
    const failures: Array<{ phase: string; code: string }> = [];
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
      4,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Версия 1.0.0"),
    ));
    await bot.handleUpdate(callbackUpdate(
      5,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Начать"),
    ));
    expect(latestScreen(telegram.calls).payload.text)
      .toBe("Квест запущен. Продолжение сохранено в /sessions.");

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
      8,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Версия 1.0.0"),
    ));
    await bot.handleUpdate(callbackUpdate(
      9,
      privateUserId,
      messageId,
      buttonData(telegram.calls, "Начать"),
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
      latestMessageId(telegram.calls),
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
      buttonData(telegram.calls, "Две двери · 1.0.0 · в процессе"),
    ));
    expect(String(latestScreen(telegram.calls).payload.text)).toContain("Прохождение найдено и сохранено.");

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
      encodePrivateQuestCallback({ kind: "start", versionId: "missing-version" }),
    ));
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
        listVersions: app.catalog.listVersions.bind(app.catalog),
        getQuestVersion: app.catalog.getQuestVersion.bind(app.catalog),
      },
      sessions: app.sessions,
    }));
    registerPrivateQuestHandlers(bot, getApplication);

    await bot.handleUpdate(commandUpdate(1, privateUserId, "/quests"));

    expect(latestScreen(telegram.calls).payload.text).toBe("Доступных квестов пока нет.");
    expect(JSON.stringify(latestScreen(telegram.calls).payload.reply_markup))
      .not.toContain("Две двери");
    expect(buttonData(telegram.calls, "В меню")).toBeDefined();
  });
});
