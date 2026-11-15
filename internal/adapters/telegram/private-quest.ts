import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { Session } from "../../domain/model.js";
import { SessionError } from "../../app/session-store.js";
import type { QuestCatalog } from "../../app/quest-catalog.js";
import type { SessionService } from "../../app/sessions.js";
import {
  CallbackDataError,
  encodePrivateQuestCallback,
  parsePrivateQuestCallback,
  type PrivateQuestCallback,
} from "./callbacks.js";
import { sendScene } from "./scene-presenter.js";

const PRIVATE_SESSION_PAGE_ITEMS = 20;

export interface PrivateQuestApplication {
  catalog: QuestCatalog;
  sessions: Pick<
    SessionService,
    "applyDecision" | "createSession" | "getSession" | "listOwnedSessions" | "startSession"
  >;
}

type GetPrivateQuestApplication = () => Promise<PrivateQuestApplication>;
type FailurePhase =
  | "catalog"
  | "sessions"
  | "session_create"
  | "session_open"
  | "session_decision"
  | "scene";

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

function sessionMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Мои прохождения", { kind: "sessions" });
  addButton(keyboard, "В меню", { kind: "menu" });
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

function createChoiceKeyboard(session: Session): {
  keyboard: InlineKeyboard;
  skippedChoices: number;
} {
  const keyboard = new InlineKeyboard();
  const turn = session.turns[0];
  let skippedChoices = 0;

  for (const choice of turn?.choices ?? []) {
    const label = choice.text.trim() || `Выбор ${choice.index + 1}`;
    if (!addButton(keyboard, label, {
      kind: "choice",
      sessionId: session.id,
      stateVersion: session.stateVersion,
      choiceIndex: choice.index,
    })) {
      skippedChoices += 1;
    }
  }

  return { keyboard, skippedChoices };
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

async function sendSessionOutput(
  context: Context,
  session: Session,
  updateId: number,
): Promise<void> {
  const chatId = context.chatId;
  if (chatId === undefined) {
    throw new SessionError("INVALID_TRANSITION", "Private chat is unavailable.");
  }

  if (session.status === "completed") {
    if (session.finalScene !== null) {
      await sendScene(context.api, chatId, session.finalScene.text, updateId);
    }
    return;
  }

  const turn = session.turns[0];
  if (turn === undefined) {
    throw new SessionError("STORY_MISMATCH", "Session has no current turn.");
  }

  if (session.status === "active") {
    const { keyboard, skippedChoices } = createChoiceKeyboard(session);
    if (skippedChoices > 0) {
      throw new CallbackDataError();
    }
    await sendScene(
      context.api,
      chatId,
      turn.sceneText,
      updateId,
      keyboard.inline_keyboard.length === 0 ? undefined : keyboard,
    );
    return;
  }

  await sendScene(context.api, chatId, turn.sceneText, updateId);
}

async function showSession(
  context: Context,
  application: PrivateQuestApplication,
  owner: { type: "user"; id: string },
  sessionId: string,
  updateId: number,
): Promise<void> {
  let session = await application.sessions.getSession(owner, sessionId);
  if (session.status === "created") {
    session = await application.sessions.startSession(owner, session.id, session.stateVersion);
  }

  const version = await application.catalog.getQuestVersion(session.questVersionId);
  const quests = version === null ? [] : await application.catalog.listAvailableQuests();
  const quest = version === null ? undefined : quests.find((item) => item.id === version.questId);
  const title = quest?.title ?? "Квест";
  const versionText = version === null ? "" : ` · версия ${version.version}`;
  await showScreen(
    context,
    `${title}${versionText}\nСтатус: ${statusLabel(session.status)}\n\nПродолжение загружено из сохранённого прохождения.`,
    sessionMenuKeyboard(),
  );
  await sendSessionOutput(context, session, updateId);
}

function failurePhase(callback: PrivateQuestCallback): FailurePhase {
  switch (callback.kind) {
    case "sessions":
    case "sessions_page":
      return "sessions";
    case "session":
      return "session_open";
    case "choice":
      return "session_decision";
    case "start":
      return "session_create";
    case "menu":
    case "quests":
    case "quest":
    case "version":
      return "catalog";
  }
}

function isExpectedChoiceFailure(error: unknown): boolean {
  return error instanceof SessionError && [
    "CONFLICT",
    "DUPLICATE_OPERATION",
    "FORBIDDEN_OWNER",
    "INVALID_CHOICE",
    "INVALID_TRANSITION",
    "NOT_FOUND",
  ].includes(error.code);
}

async function handleChoiceCallback(
  context: Context,
  getApplication: GetPrivateQuestApplication,
  owner: { type: "user"; id: string },
  callback: Extract<PrivateQuestCallback, { kind: "choice" }>,
  logger: PrivateQuestLogger,
): Promise<void> {
  const refreshText = "Ход изменился. Откройте /sessions, чтобы увидеть продолжение.";
  let application: PrivateQuestApplication;
  let session: Session;

  try {
    application = await getApplication();
    session = await application.sessions.getSession(owner, callback.sessionId);
  } catch (error) {
    logFailure(logger, "session_decision", error);
    await context.answerCallbackQuery({ text: refreshText });
    return;
  }

  const turn = session.turns[0];
  if (
    session.status !== "active" ||
    session.stateVersion !== callback.stateVersion ||
    turn === undefined ||
    turn.decision !== null ||
    !turn.choices.some((choice) => choice.index === callback.choiceIndex)
  ) {
    await context.answerCallbackQuery({ text: refreshText });
    return;
  }

  let updated: Session;
  try {
    updated = await application.sessions.applyDecision(
      owner,
      session.id,
      turn.id,
      callback.choiceIndex,
      callback.stateVersion,
      context.update.update_id,
    );
  } catch (error) {
    if (!isExpectedChoiceFailure(error)) {
      logFailure(logger, "session_decision", error);
    }
    await context.answerCallbackQuery({ text: refreshText });
    return;
  }

  try {
    await context.answerCallbackQuery();
  } catch (error) {
    logFailure(logger, "scene", error);
  }

  try {
    await context.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    logFailure(logger, "scene", error);
  }

  try {
    await sendSessionOutput(context, updated, context.update.update_id);
  } catch (error) {
    logFailure(logger, "scene", error);
    try {
      await context.reply("Ход сохранён. Откройте /sessions, чтобы восстановить продолжение.");
    } catch (recoveryError) {
      logFailure(logger, "scene", recoveryError);
    }
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

  if (callback.kind === "choice") {
    await handleChoiceCallback(context, getApplication, owner, callback, logger);
    return;
  }

  await context.answerCallbackQuery();

  let activePhase = failurePhase(callback);
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
        activePhase = "session_create";
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

        activePhase = "scene";
        await showSession(context, application, owner, started.id, context.update.update_id);
        return;
      }
      case "sessions":
        await showSessions(context, application, owner, null);
        return;
      case "sessions_page":
        await showSessions(context, application, owner, callback.cursor);
        return;
      case "session":
        activePhase = "session_open";
        await showSession(context, application, owner, callback.sessionId, context.update.update_id);
        return;
    }
  } catch (error) {
    logFailure(logger, activePhase, error);
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
