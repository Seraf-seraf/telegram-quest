import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { Quest } from "../../domain/model.js";
import { SessionError } from "../../app/session-store.js";
import type { QuestCatalog } from "../../app/quest-catalog.js";
import type { SessionService } from "../../app/sessions.js";
import {
  CallbackDataError,
  encodePrivateQuestCallback,
  parsePrivateQuestCallback,
  type PrivateQuestCallback,
} from "./callbacks.js";

const PRIVATE_SESSION_PAGE_ITEMS = 20;

export interface PrivateQuestApplication {
  catalog: QuestCatalog;
  sessions: Pick<
    SessionService,
    "createSession" | "getSession" | "listOwnedSessions" | "startSession"
  >;
}

type GetPrivateQuestApplication = () => Promise<PrivateQuestApplication>;
type FailurePhase = "catalog" | "sessions" | "session_create" | "session_open";

interface PrivateQuestFailureEvent {
  event: "telegram_quest.private_handler_failed";
  phase: FailurePhase;
  code: string;
}

type PrivateQuestLogger = (event: PrivateQuestFailureEvent) => void;

function getPrivateOwner(context: Context): { type: "user"; id: string } | null {
  const message = context.callbackQuery?.message ?? context.message;
  if (message?.chat.type !== "private" || context.from === undefined) {
    return null;
  }

  return { type: "user", id: String(context.from.id) };
}

function callbackData(callback: PrivateQuestCallback): string | null {
  try {
    return encodePrivateQuestCallback(callback);
  } catch (error) {
    if (error instanceof CallbackDataError) {
      return null;
    }
    throw error;
  }
}

function buttonText(text: string): string {
  const characters = [...text];
  if (characters.length <= 64) {
    return text;
  }
  return `${characters.slice(0, 61).join("")}…`;
}

function addButton(
  keyboard: InlineKeyboard,
  text: string,
  callback: PrivateQuestCallback,
): boolean {
  const data = callbackData(callback);
  if (data === null) {
    return false;
  }
  keyboard.text(buttonText(text), data).row();
  return true;
}

function mainMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Квесты", { kind: "quests" });
  addButton(keyboard, "Мои прохождения", { kind: "sessions" });
  return keyboard;
}

function menuErrorText(error: unknown): string {
  if (error instanceof SessionError && error.code === "DUPLICATE_OPERATION") {
    return "Запрос уже обработан. Проверьте список в /sessions.";
  }
  return "Не удалось выполнить действие. Откройте /menu и попробуйте ещё раз.";
}

function failureCode(error: unknown): string {
  if (error instanceof SessionError) {
    return error.code;
  }
  if (error instanceof CallbackDataError) {
    return "CALLBACK_DATA_INVALID";
  }
  return "INTERNAL_ERROR";
}

function logFailure(
  logger: PrivateQuestLogger,
  phase: FailurePhase,
  error: unknown,
): void {
  logger({
    event: "telegram_quest.private_handler_failed",
    phase,
    code: failureCode(error),
  });
}

async function showScreen(
  context: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  if (context.callbackQuery?.message !== undefined) {
    await context.editMessageText(text, { reply_markup: keyboard });
  } else {
    await context.reply(text, { reply_markup: keyboard });
  }
}

async function showMainMenu(context: Context): Promise<void> {
  await showScreen(
    context,
    "Личный квест. Выберите действие.",
    mainMenuKeyboard(),
  );
}

function questLabel(quest: Quest): string {
  return `${quest.title} · ${quest.genre}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "created":
      return "не начат";
    case "active":
      return "в процессе";
    case "paused":
      return "на паузе";
    case "completed":
      return "завершён";
    default:
      return "сохранён";
  }
}

async function showQuestList(
  context: Context,
  application: PrivateQuestApplication,
): Promise<void> {
  const quests = await application.catalog.listAvailableQuests();
  const keyboard = new InlineKeyboard();
  let skippedButtons = 0;

  for (const quest of quests) {
    if (!addButton(keyboard, quest.title, { kind: "quest", questId: quest.id })) {
      skippedButtons += 1;
    }
  }
  addButton(keyboard, "В меню", { kind: "menu" });

  let text = quests.length === 0 ? "Доступных квестов пока нет." : "Выберите квест.";
  if (skippedButtons > 0) {
    text += " Некоторые квесты нельзя открыть из-за длины их идентификатора.";
  }
  await showScreen(context, text, keyboard);
}

async function showQuestVersions(
  context: Context,
  application: PrivateQuestApplication,
  questId: string,
): Promise<void> {
  const quests = await application.catalog.listAvailableQuests();
  const quest = quests.find((item) => item.id === questId);
  if (quest === undefined) {
    const keyboard = mainMenuKeyboard();
    await showScreen(context, "Квест больше недоступен. Откройте каталог заново.", keyboard);
    return;
  }

  const versions = await application.catalog.listVersions(quest.id);
  const keyboard = new InlineKeyboard();
  let skippedButtons = 0;
  for (const version of versions) {
    if (!addButton(keyboard, `Версия ${version.version}`, {
      kind: "version",
      versionId: version.id,
    })) {
      skippedButtons += 1;
    }
  }
  addButton(keyboard, "Назад к квестам", { kind: "quests" });
  addButton(keyboard, "В меню", { kind: "menu" });

  let text = `${quest.title}\nЖанр: ${quest.genre}\n\n${quest.description}`;
  text += versions.length === 0 ? "\n\nДоступных версий пока нет." : "\n\nВыберите версию.";
  if (skippedButtons > 0) {
    text += " Некоторые версии нельзя открыть из-за длины их идентификатора.";
  }
  await showScreen(context, text, keyboard);
}

async function showVersion(
  context: Context,
  application: PrivateQuestApplication,
  versionId: string,
): Promise<void> {
  const version = await application.catalog.getQuestVersion(versionId);
  if (version === null) {
    await showScreen(context, "Версия больше недоступна. Откройте каталог заново.", mainMenuKeyboard());
    return;
  }

  const quests = await application.catalog.listAvailableQuests();
  const quest = quests.find((item) => item.id === version.questId);
  if (quest === undefined) {
    await showScreen(context, "Квест больше недоступен. Откройте каталог заново.", mainMenuKeyboard());
    return;
  }

  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Начать", { kind: "start", versionId: version.id });
  addButton(keyboard, "Назад к версиям", { kind: "quest", questId: quest.id });
  addButton(keyboard, "В меню", { kind: "menu" });
  await showScreen(
    context,
    `${quest.title}\nВерсия ${version.version}\n\n${quest.description}`,
    keyboard,
  );
}

async function showSessions(
  context: Context,
  application: PrivateQuestApplication,
  owner: { type: "user"; id: string },
  cursor: string | null,
): Promise<void> {
  const page = await application.sessions.listOwnedSessions(
    owner,
    PRIVATE_SESSION_PAGE_ITEMS,
    cursor,
  );
  const keyboard = new InlineKeyboard();
  let skippedButtons = 0;

  for (const session of page.sessions) {
    const label = `${session.questTitle} · ${session.questVersion} · ${statusLabel(session.status)}`;
    if (!addButton(keyboard, label, { kind: "session", sessionId: session.id })) {
      skippedButtons += 1;
    }
  }
  if (page.nextCursor !== null) {
    addButton(keyboard, "Далее", { kind: "sessions_page", cursor: page.nextCursor });
  }
  addButton(keyboard, "В меню", { kind: "menu" });

  let text = page.sessions.length === 0
    ? "Личных прохождений пока нет."
    : "Ваши личные прохождения:";
  if (skippedButtons > 0) {
    text += " Некоторые прохождения нельзя открыть из-за длины их идентификатора.";
  }
  await showScreen(context, text, keyboard);
}

async function showSession(
  context: Context,
  application: PrivateQuestApplication,
  owner: { type: "user"; id: string },
  sessionId: string,
): Promise<void> {
  const session = await application.sessions.getSession(owner, sessionId);
  const version = await application.catalog.getQuestVersion(session.questVersionId);
  const quests = version === null ? [] : await application.catalog.listAvailableQuests();
  const quest = version === null ? undefined : quests.find((item) => item.id === version.questId);
  const title = quest?.title ?? "Квест";
  const versionText = version === null ? "" : ` · версия ${version.version}`;
  const stepText = session.turns[0] === undefined
    ? ""
    : ` · ход ${session.turns[0].stepNumber}`;
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "К прохождениям", { kind: "sessions" });
  addButton(keyboard, "В меню", { kind: "menu" });
  await showScreen(
    context,
    `${title}${versionText}\nСтатус: ${statusLabel(session.status)}${stepText}\n\nПрохождение найдено и сохранено.`,
    keyboard,
  );
}

function failurePhase(callback: PrivateQuestCallback): FailurePhase {
  switch (callback.kind) {
    case "sessions":
    case "sessions_page":
      return "sessions";
    case "session":
      return "session_open";
    case "start":
      return "session_create";
    case "menu":
    case "quests":
    case "quest":
    case "version":
      return "catalog";
  }
}

async function handleCallback(
  context: Context,
  getApplication: GetPrivateQuestApplication,
  logger: PrivateQuestLogger,
): Promise<void> {
  const owner = getPrivateOwner(context);
  if (owner === null) {
    await context.answerCallbackQuery({ text: "Откройте квест в личном чате с ботом." });
    return;
  }

  const callback = parsePrivateQuestCallback(context.callbackQuery?.data);
  if (callback === null) {
    await context.answerCallbackQuery({ text: "Кнопка устарела. Откройте /menu." });
    return;
  }

  await context.answerCallbackQuery();

  try {
    const application = await getApplication();
    switch (callback.kind) {
      case "menu":
        await showMainMenu(context);
        return;
      case "quests":
        await showQuestList(context, application);
        return;
      case "quest":
        await showQuestVersions(context, application, callback.questId);
        return;
      case "version":
        await showVersion(context, application, callback.versionId);
        return;
      case "start": {
        const version = await application.catalog.getQuestVersion(callback.versionId);
        if (version === null) {
          await showScreen(context, "Версия больше недоступна. Откройте каталог заново.", mainMenuKeyboard());
          return;
        }

        const created = await application.sessions.createSession(
          owner,
          version.id,
          context.update.update_id,
        );
        let started;
        try {
          started = await application.sessions.startSession(
            owner,
            created.id,
            created.stateVersion,
          );
        } catch (error) {
          logFailure(logger, "session_create", error);
          const keyboard = new InlineKeyboard();
          addButton(keyboard, "Мои прохождения", { kind: "sessions" });
          addButton(keyboard, "В меню", { kind: "menu" });
          await showScreen(
            context,
            "Прохождение сохранено. Откройте /sessions, чтобы восстановить его.",
            keyboard,
          );
          return;
        }

        const keyboard = new InlineKeyboard();
        addButton(keyboard, "Мои прохождения", { kind: "sessions" });
        addButton(keyboard, "В меню", { kind: "menu" });
        const text = started.status === "completed"
          ? "Квест запущен и сразу завершён. Откройте /sessions."
          : "Квест запущен. Продолжение сохранено в /sessions.";
        await showScreen(context, text, keyboard);
        return;
      }
      case "sessions":
        await showSessions(context, application, owner, null);
        return;
      case "sessions_page":
        await showSessions(context, application, owner, callback.cursor);
        return;
      case "session":
        await showSession(context, application, owner, callback.sessionId);
        return;
    }
  } catch (error) {
    logFailure(logger, failurePhase(callback), error);
    await showScreen(context, menuErrorText(error), mainMenuKeyboard());
  }
}

export function registerPrivateQuestHandlers(
  bot: Bot,
  getApplication: GetPrivateQuestApplication,
  logger: PrivateQuestLogger = (event) => {
    console.error(JSON.stringify(event));
  },
): void {
  const handleCommand = async (
    context: Context,
    command: "menu" | "quests" | "sessions",
  ): Promise<void> => {
    const owner = getPrivateOwner(context);
    if (owner === null) {
      return;
    }

    try {
      if (command === "menu") {
        await showMainMenu(context);
        return;
      }
      const application = await getApplication();
      if (command === "quests") {
        await showQuestList(context, application);
      } else {
        await showSessions(context, application, owner, null);
      }
    } catch (error) {
      logFailure(logger, command === "sessions" ? "sessions" : "catalog", error);
      await context.reply(menuErrorText(error), { reply_markup: mainMenuKeyboard() });
    }
  };

  bot.command("start", (context) => handleCommand(context, "menu"));
  bot.command("menu", (context) => handleCommand(context, "menu"));
  bot.command("quests", (context) => handleCommand(context, "quests"));
  bot.command("sessions", (context) => handleCommand(context, "sessions"));
  bot.on("callback_query:data", (context) => handleCallback(context, getApplication, logger));
}
