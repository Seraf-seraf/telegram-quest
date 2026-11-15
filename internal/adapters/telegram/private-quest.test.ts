import { createClient, type Transaction } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const temporaryDirectories: string[] = [];

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
  let nextMessageId = 100;
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
    ].includes(method)
      ? true
      : (() => {
        responseMessageId = typeof payload.message_id === "number"
          ? payload.message_id
          : nextMessageId++;
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

function buttonDataForMessage(
  calls: TelegramCall[],
  messageId: number,
  text: string,
): string {
  const screen = calls.filter((call) =>
    (call.method === "sendMessage" || call.method === "editMessageText") &&
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
      await bot.handleUpdate(callbackUpdate(
        firstUpdateId + 2,
        userId,
        panelMessageId,
        buttonData(telegram.calls, "Версия 1.0.0"),
      ));
      if (failSceneSend) {
        telegram.failNext("sendMessage");
      }
      await bot.handleUpdate(callbackUpdate(
        firstUpdateId + 3,
        userId,
        panelMessageId,
        buttonData(telegram.calls, "Начать"),
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
      buttonData(telegram.calls, "Две двери · 1.0.0 · в процессе"),
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
      buttonData(telegram.calls, "Две двери · 1.0.0 · в процессе"),
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
  });
});
