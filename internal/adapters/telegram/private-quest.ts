import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { Session } from "../../domain/model.js";
import { assetReferences, type ContentResolver } from "../../app/content.js";
import { SessionError } from "../../app/session-store.js";
import type { QuestCatalog } from "../../app/quest-catalog.js";
import type { SessionService } from "../../app/sessions.js";
import {
  genreListView,
  historyView,
  mainMenuView,
  questCardView,
  questListView,
  sessionsView,
  type MenuAction,
  type MenuView,
} from "../../app/menu.js";
import { createPage } from "../../app/pagination.js";
import {
  CallbackDataError,
  encodePrivateQuestCallback,
  parsePrivateQuestCallback,
  type PrivateQuestCallback,
} from "./callbacks.js";
import {
  getExistingMenuMessage,
  presentMenu,
  resolveMenuCallbackData,
} from "./menu-presenter.js";
import { sendScene } from "./scene-presenter.js";

const PRIVATE_SESSION_PAGE_ITEMS = 20;

export interface PrivateQuestApplication {
  catalog: QuestCatalog;
  resolveContent: ContentResolver;
  sessions: Pick<
    SessionService,
    "applyDecision" | "createSession" | "getSession" | "listOwnedSessions" | "startSession"
      | "listTurns" | "pauseSession" | "resumeSession" | "stopSession"
      | "restartSession" | "rewindSession" | "listOwnedSessionsPage" | "listTurnSummariesPage"
  >;
}

type GetPrivateQuestApplication = () => Promise<PrivateQuestApplication>;
type SessionControlCallback = Extract<
  PrivateQuestCallback,
  {
    kind:
      | "manage"
      | "pause"
      | "resume"
      | "stop_prompt"
      | "stop_confirm"
      | "restart_prompt"
      | "restart_confirm"
      | "rewind_list"
      | "rewind_prompt"
      | "rewind_confirm"
      | "history_page"
      | "history_target";
  }
>;
type FailurePhase =
  | "catalog"
  | "sessions"
  | "session_create"
  | "session_open"
  | "session_decision"
  | "session_lifecycle"
  | "session_history"
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
  return keyboardForMenuView(mainMenuView());
}

function callbackForMenuAction(action: MenuAction): PrivateQuestCallback {
  switch (action.kind) {
    case "menu": return { kind: "menu" };
    case "genres_page": return { kind: "genres_page", page: action.page };
    case "genre": return { kind: "genre", key: action.key, genrePage: action.genrePage };
    case "quests_page": return {
      kind: "quests_page", page: action.page, genreKey: action.genreKey, genrePage: action.genrePage,
    };
    case "quest_card": return {
      kind: "quest_card", questId: action.questId, catalogPage: action.catalogPage,
      genreKey: action.genreKey, genrePage: action.genrePage,
    };
    case "start_quest": return { kind: "start", questId: action.questId };
    case "sessions_page": return { kind: "sessions_number_page", page: action.page };
    case "session": return { kind: "session", sessionId: action.sessionId };
    case "manage": return { kind: "manage", sessionId: action.sessionId, stateVersion: action.stateVersion };
    case "history_page": return {
      kind: "history_page", sessionId: action.sessionId, stateVersion: action.stateVersion, page: action.page,
    };
    case "history_target": return {
      kind: "history_target", sessionId: action.sessionId, stateVersion: action.stateVersion,
      targetStepNo: action.targetStepNo,
    };
    case "pause": return { kind: "pause", sessionId: action.sessionId, stateVersion: action.stateVersion };
    case "resume": return { kind: "resume", sessionId: action.sessionId, stateVersion: action.stateVersion };
    case "stop_prompt": return { kind: "stop_prompt", sessionId: action.sessionId, stateVersion: action.stateVersion };
    case "restart_prompt": return { kind: "restart_prompt", sessionId: action.sessionId, stateVersion: action.stateVersion };
    case "noop": return { kind: "noop" };
  }
}

function keyboardForMenuView(view: MenuView): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of view.rows) {
    for (const button of row) {
      const data = callbackData(callbackForMenuAction(button.action));
      if (data !== null) keyboard.text(buttonText(button.text), data);
    }
    keyboard.row();
  }
  return keyboard;
}

async function showMenuView(
  context: Context,
  application: PrivateQuestApplication,
  view: MenuView,
  references: readonly string[] = [],
  questId: string | null = null,
): Promise<void> {
  await showResolvedScreen(context, application, questId, view.content.text, references, keyboardForMenuView(view));
}

function sessionMenuKeyboard(session: Session): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Управление", {
    kind: "manage",
    sessionId: session.id,
    stateVersion: session.stateVersion,
  });
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
  const chatId = context.chatId;
  if (chatId === undefined) {
    throw new SessionError("INVALID_TRANSITION", "Private chat is unavailable.");
  }
  await presentMenu(context.api, chatId, currentMenuMessage(context), { text }, keyboard);
}

function currentMenuMessage(context: Context) {
  const message = context.callbackQuery?.message;
  const chatId = context.chatId;
  if (message === undefined || chatId === undefined) {
    return undefined;
  }
  return getExistingMenuMessage(
    chatId,
    message.message_id,
    "photo" in message,
    context.callbackQuery?.data,
  );
}

async function showResolvedScreen(
  context: Context,
  application: PrivateQuestApplication,
  questId: string | null,
  text: string,
  references: readonly string[],
  keyboard: InlineKeyboard,
): Promise<void> {
  const chatId = context.chatId;
  if (chatId === undefined) {
    throw new SessionError("INVALID_TRANSITION", "Private chat is unavailable.");
  }
  const view = await application.resolveContent(questId, text, references);
  await presentMenu(context.api, chatId, currentMenuMessage(context), view, keyboard);
}

async function showMainMenu(
  context: Context,
  application: PrivateQuestApplication,
): Promise<void> {
  await showMenuView(context, application, mainMenuView(), ["menu.main.banner"]);
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
  pageNumber: number,
  genreKey: string | null,
  genrePage: number,
  staleGenre = false,
): Promise<void> {
  const genre = genreKey === null ? undefined : await application.catalog.resolveGenreKey(genreKey);
  if (genreKey !== null && genre === null) {
    const view = genreListView(await application.catalog.listGenresPage(genrePage));
    view.content.text = `Жанр больше недоступен. Выберите другой.\n\n${view.content.text}`;
    await showMenuView(context, application, view);
    return;
  }
  const page = await application.catalog.listQuestsPage(pageNumber, genre === null ? undefined : genre);
  const view = questListView(page, genreKey, genrePage);
  if (staleGenre) view.content.text = `Жанр больше недоступен. Выберите другой.\n\n${view.content.text}`;
  await showMenuView(context, application, view, ["menu.quests.banner"]);
}

async function showQuestCard(
  context: Context,
  application: PrivateQuestApplication,
  questId: string,
  catalogPage = 1,
  genreKey: string | null = null,
  genrePage = 1,
): Promise<void> {
  const quest = await application.catalog.getQuest(questId);
  if (quest === null || !quest.available) {
    await showQuestList(context, application, catalogPage, genreKey, genrePage, true);
    return;
  }
  await showMenuView(context, application, questCardView(quest, catalogPage, genreKey, genrePage), ["cover"], quest.id);
}

async function showGenres(context: Context, application: PrivateQuestApplication, page: number): Promise<void> {
  await showMenuView(context, application, genreListView(await application.catalog.listGenresPage(page)));
}

async function showQuestPage(
  context: Context,
  application: PrivateQuestApplication,
  page: number,
  genreKey: string | null,
  genrePage: number,
): Promise<void> {
  await showQuestList(context, application, page, genreKey, genrePage);
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
    const label = `${session.questTitle} · ${statusLabel(session.status)}`;
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
  await showResolvedScreen(context, application, null, text, ["menu.sessions.banner"], keyboard);
}

async function showSessionsPage(
  context: Context,
  application: PrivateQuestApplication,
  owner: { type: "user"; id: string },
  page: number,
): Promise<void> {
  const result = await application.sessions.listOwnedSessionsPage(owner, page);
  await showMenuView(context, application, sessionsView(result), ["menu.sessions.banner"]);
}

async function sendSessionOutput(
  context: Context,
  application: PrivateQuestApplication,
  session: Session,
  updateId: number,
): Promise<void> {
  const chatId = context.chatId;
  if (chatId === undefined) {
    throw new SessionError("INVALID_TRANSITION", "Private chat is unavailable.");
  }

  if (session.status === "completed") {
    if (session.finalScene !== null) {
      const view = await application.resolveContent(
        session.questId,
        session.finalScene.text,
        assetReferences(session.finalScene.tags),
      );
      await sendScene(context.api, chatId, view, updateId);
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
    const view = await application.resolveContent(
      session.questId,
      turn.sceneText,
      assetReferences(turn.sceneTags),
    );
    await sendScene(
      context.api,
      chatId,
      view,
      updateId,
      keyboard.inline_keyboard.length === 0 ? undefined : keyboard,
    );
    return;
  }

  const view = await application.resolveContent(
    session.questId,
    turn.sceneText,
    assetReferences(turn.sceneTags),
  );
  await sendScene(context.api, chatId, view, updateId);
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

  const quest = await application.catalog.getQuest(session.questId);
  const title = quest?.title ?? "Квест";
  const sessionMessage = session.status === "paused"
    ? "Прохождение на паузе."
    : session.status === "completed"
      ? session.outcome === "stopped_by_owner"
        ? "Прохождение остановлено."
        : "Квест завершён."
      : "Продолжение загружено из сохранённого прохождения.";
  await showScreen(
    context,
    `${title}\nСтатус: ${statusLabel(session.status)}\n\n${sessionMessage}`,
    sessionMenuKeyboard(session),
  );
  await sendSessionOutput(context, application, session, updateId);
}

function sessionControlsKeyboard(session: Session): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Показать сцену", { kind: "session", sessionId: session.id });

  if (session.status === "active") {
    addButton(keyboard, "Пауза", {
      kind: "pause",
      sessionId: session.id,
      stateVersion: session.stateVersion,
    });
  } else if (session.status === "paused") {
    addButton(keyboard, "Продолжить игру", {
      kind: "resume",
      sessionId: session.id,
      stateVersion: session.stateVersion,
    });
  }

  if (session.status !== "completed") {
    addButton(keyboard, "Остановить", {
      kind: "stop_prompt",
      sessionId: session.id,
      stateVersion: session.stateVersion,
    });
  }
  addButton(keyboard, "Начать заново", {
    kind: "restart_prompt",
    sessionId: session.id,
    stateVersion: session.stateVersion,
  });
  addButton(keyboard, "История ходов", {
    kind: "rewind_list",
    sessionId: session.id,
    stateVersion: session.stateVersion,
  });
  addButton(keyboard, "К прохождениям", { kind: "sessions" });
  return keyboard;
}

function historyDescription(sceneText: string): string {
  const normalizedText = sceneText.replace(/\s+/gu, " ").trim();
  return normalizedText.length === 0 ? "Пустая сцена" : buttonText(normalizedText);
}

async function showSessionControls(context: Context, session: Session): Promise<void> {
  await showScreen(
    context,
    `Управление прохождением\nСтатус: ${statusLabel(session.status)}`,
    sessionControlsKeyboard(session),
  );
}

async function showStopConfirmation(context: Context, session: Session): Promise<void> {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Подтвердить остановку", {
    kind: "stop_confirm",
    sessionId: session.id,
    stateVersion: session.stateVersion,
    confirmed: true,
  });
  addButton(keyboard, "Отмена", {
    kind: "stop_confirm",
    sessionId: session.id,
    stateVersion: session.stateVersion,
    confirmed: false,
  });
  await showScreen(context, "Остановить прохождение? Оно завершится без финала.", keyboard);
}

async function showRestartConfirmation(context: Context, session: Session): Promise<void> {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Подтвердить перезапуск", {
    kind: "restart_confirm",
    sessionId: session.id,
    stateVersion: session.stateVersion,
    confirmed: true,
  });
  addButton(keyboard, "Отмена", {
    kind: "restart_confirm",
    sessionId: session.id,
    stateVersion: session.stateVersion,
    confirmed: false,
  });
  await showScreen(
    context,
    "Начать прохождение заново? Текущие ходы и выборы будут удалены.",
    keyboard,
  );
}

async function showRewindConfirmation(
  context: Context,
  session: Session,
  targetStepNo: number,
  targetScene: string,
): Promise<void> {
  const keyboard = new InlineKeyboard();
  addButton(keyboard, "Подтвердить откат", {
    kind: "rewind_confirm",
    sessionId: session.id,
    stateVersion: session.stateVersion,
    targetStepNo,
    confirmed: true,
  });
  addButton(keyboard, "Отмена", {
    kind: "rewind_confirm",
    sessionId: session.id,
    stateVersion: session.stateVersion,
    targetStepNo,
    confirmed: false,
  });
  await showScreen(
    context,
    `Откатиться к ходу ${targetStepNo}: ${historyDescription(targetScene)}? Более поздние ходы будут удалены.`,
    keyboard,
  );
}

async function showSessionHistory(
  context: Context,
  application: PrivateQuestApplication,
  owner: { type: "user"; id: string },
  session: Session,
  pageNumber: number,
): Promise<void> {
  const canRewind = session.status === "active" || session.status === "paused";
  const page = await application.sessions.listTurnSummariesPage(owner, session.id, pageNumber);
  await showMenuView(context, application, historyView(page, session.id, session.stateVersion, canRewind));
}

function failurePhase(callback: PrivateQuestCallback): FailurePhase {
  switch (callback.kind) {
    case "sessions":
    case "sessions_page":
    case "sessions_number_page":
      return "sessions";
    case "history_page":
    case "history_target":
      return "session_history";
    case "session":
      return "session_open";
    case "choice":
      return "session_decision";
    case "manage":
    case "pause":
    case "resume":
    case "stop_prompt":
    case "stop_confirm":
    case "restart_prompt":
    case "restart_confirm":
      return "session_lifecycle";
    case "rewind_list":
    case "rewind_prompt":
    case "rewind_confirm":
    case "history_page":
    case "history_target":
      return "session_history";
    case "start":
      return "session_create";
    case "menu":
    case "quests":
    case "quest":
    case "genres_page":
    case "genre":
    case "quests_page":
    case "quest_card":
    case "noop":
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

function isSessionControlCallback(callback: PrivateQuestCallback): callback is SessionControlCallback {
  switch (callback.kind) {
    case "manage":
    case "pause":
    case "resume":
    case "stop_prompt":
    case "stop_confirm":
    case "restart_prompt":
    case "restart_confirm":
    case "rewind_list":
    case "rewind_prompt":
    case "rewind_confirm":
    case "history_page":
    case "history_target":
      return true;
    default:
      return false;
  }
}

async function handleSessionControlCallback(
  context: Context,
  getApplication: GetPrivateQuestApplication,
  owner: { type: "user"; id: string },
  callback: SessionControlCallback,
  logger: PrivateQuestLogger,
): Promise<void> {
  const refreshText = "Прохождение изменилось. Откройте /sessions и выберите его снова.";
  let activePhase = failurePhase(callback);
  let callbackAnswered = false;

  const answer = async (text?: string): Promise<void> => {
    if (callbackAnswered) {
      return;
    }
    callbackAnswered = true;
    try {
      if (text === undefined) {
        await context.answerCallbackQuery();
      } else {
        await context.answerCallbackQuery({ text });
      }
    } catch (error) {
      logFailure(logger, activePhase, error);
    }
  };

  try {
    const application = await getApplication();
    const session = await application.sessions.getSession(owner, callback.sessionId);
    if (session.stateVersion !== callback.stateVersion) {
      if (callback.kind === "manage") {
        await answer(refreshText);
        await showSessionControls(context, session);
        return;
      }
      await answer(refreshText);
      return;
    }

    switch (callback.kind) {
      case "manage":
        await answer();
        await showSessionControls(context, session);
        return;
      case "pause": {
        if (session.status !== "active") {
          await answer(refreshText);
          return;
        }
        const paused = await application.sessions.pauseSession(
          owner,
          session.id,
          callback.stateVersion,
        );
        await answer();
        activePhase = "scene";
        await showSession(context, application, owner, paused.id, context.update.update_id);
        return;
      }
      case "resume": {
        if (session.status !== "paused") {
          await answer(refreshText);
          return;
        }
        const resumed = await application.sessions.resumeSession(
          owner,
          session.id,
          callback.stateVersion,
        );
        await answer();
        activePhase = "scene";
        await showSession(context, application, owner, resumed.id, context.update.update_id);
        return;
      }
      case "stop_prompt":
        if (session.status === "completed") {
          await answer(refreshText);
          return;
        }
        await answer();
        await showStopConfirmation(context, session);
        return;
      case "stop_confirm":
        if (!callback.confirmed) {
          await answer();
          await showSessionControls(context, session);
          return;
        }
        if (session.status === "completed") {
          await answer(refreshText);
          return;
        }
        {
          const stopped = await application.sessions.stopSession(
            owner,
            session.id,
            callback.stateVersion,
          );
          await answer();
          activePhase = "scene";
          await showSession(context, application, owner, stopped.id, context.update.update_id);
          return;
        }
      case "restart_prompt":
        await answer();
        await showRestartConfirmation(context, session);
        return;
      case "restart_confirm":
        if (!callback.confirmed) {
          await answer();
          await showSessionControls(context, session);
          return;
        }
        {
          const restarted = await application.sessions.restartSession(
            owner,
            session.id,
            callback.stateVersion,
            true,
          );
          await answer();
          activePhase = "scene";
          await showSession(context, application, owner, restarted.id, context.update.update_id);
          return;
        }
      case "rewind_list": {
        await answer();
        await showSessionHistory(context, application, owner, session, 1);
        return;
      }
      case "history_page":
        await answer();
        await showSessionHistory(context, application, owner, session, callback.page);
        return;
      case "history_target":
      case "rewind_prompt": {
        if (session.status !== "active" && session.status !== "paused") {
          await answer(refreshText);
          return;
        }
        const turns = await application.sessions.listTurns(owner, session.id);
        const target = turns.find((turn) => turn.stepNumber === callback.targetStepNo);
        if (target === undefined) {
          await answer(refreshText);
          return;
        }
        await answer();
        await showRewindConfirmation(context, session, target.stepNumber, target.sceneText);
        return;
      }
      case "rewind_confirm":
        if (!callback.confirmed) {
          await answer();
          await showSessionControls(context, session);
          return;
        }
        if (session.status !== "active" && session.status !== "paused") {
          await answer(refreshText);
          return;
        }
        {
          const turns = await application.sessions.listTurns(owner, session.id);
          if (!turns.some((turn) => turn.stepNumber === callback.targetStepNo)) {
            await answer(refreshText);
            return;
          }
          const rewound = await application.sessions.rewindSession(
            owner,
            session.id,
            callback.targetStepNo,
            callback.stateVersion,
          );
          await answer();
          activePhase = "scene";
          await showSession(context, application, owner, rewound.id, context.update.update_id);
          return;
        }
    }
  } catch (error) {
    logFailure(logger, activePhase, error);
    if (!callbackAnswered) {
      await answer(refreshText);
      return;
    }
    try {
      await context.reply("Экран не обновился. Откройте /sessions, чтобы увидеть актуальное состояние.");
    } catch (recoveryError) {
      logFailure(logger, activePhase, recoveryError);
    }
  }
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
    await sendSessionOutput(context, application, updated, context.update.update_id);
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

  const callbackMessage = context.callbackQuery?.message;
  const chatId = context.chatId;
  const replyMarkup = callbackMessage !== undefined && "reply_markup" in callbackMessage
    ? callbackMessage.reply_markup
    : undefined;
  const callbackData = callbackMessage === undefined || chatId === undefined
    ? null
    : resolveMenuCallbackData(
      context.callbackQuery?.data,
      replyMarkup,
    );
  const callback = parsePrivateQuestCallback(callbackData ?? undefined);
  if (callback === null) {
    await context.answerCallbackQuery({ text: "Меню обновилось. Откройте /menu" });
    return;
  }

  if (callback.kind === "choice") {
    await handleChoiceCallback(context, getApplication, owner, callback, logger);
    return;
  }
  if (isSessionControlCallback(callback)) {
    await handleSessionControlCallback(context, getApplication, owner, callback, logger);
    return;
  }

  await context.answerCallbackQuery();
  if (callback.kind === "noop") return;

  let activePhase = failurePhase(callback);
  try {
    const application = await getApplication();
    switch (callback.kind) {
      case "menu":
        await showMainMenu(context, application);
        return;
      case "quests":
        await showQuestPage(context, application, 1, null, 1);
        return;
      case "quest":
        await showQuestCard(context, application, callback.questId);
        return;
      case "genres_page":
        await showGenres(context, application, callback.page);
        return;
      case "genre": {
        const genre = await application.catalog.resolveGenreKey(callback.key);
        if (genre === null) {
          await showGenres(context, application, callback.genrePage);
          return;
        }
        await showQuestPage(context, application, 1, callback.key, callback.genrePage);
        return;
      }
      case "quests_page":
        await showQuestPage(context, application, callback.page, callback.genreKey, callback.genrePage);
        return;
      case "quest_card":
        await showQuestCard(context, application, callback.questId, callback.catalogPage, callback.genreKey, callback.genrePage);
        return;
      case "start": {
        activePhase = "session_create";
        const quest = await application.catalog.getQuest(callback.questId);
        if (quest === null || !quest.available) {
          await showScreen(context, "Квест больше недоступен. Откройте каталог заново.", mainMenuKeyboard());
          return;
        }

        const created = await application.sessions.createSession(
          owner,
          quest.id,
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
        await showSessionsPage(context, application, owner, 1);
        return;
      case "sessions_page":
        await showSessions(context, application, owner, callback.cursor);
        return;
      case "sessions_number_page":
        await showSessionsPage(context, application, owner, callback.page);
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
        const application = await getApplication();
        await showMainMenu(context, application);
        return;
      }
      const application = await getApplication();
      if (command === "quests") {
        await showQuestPage(context, application, 1, null, 1);
      } else {
        await showSessionsPage(context, application, owner, 1);
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
