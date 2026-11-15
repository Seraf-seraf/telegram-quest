import type { ContentView } from "./content.js";
import type { GenreEntry } from "./quest-catalog.js";
import type { Page } from "./pagination.js";
import type { OwnedSessionSummary, TurnSummary } from "./session-store.js";
import type { Quest } from "../domain/model.js";

export type MenuAction =
  | { kind: "menu" }
  | { kind: "genres_page"; page: number }
  | { kind: "genre"; key: string; genrePage: number }
  | { kind: "quests_page"; page: number; genreKey: string | null; genrePage: number }
  | { kind: "quest_card"; questId: string; catalogPage: number; genreKey: string | null; genrePage: number }
  | { kind: "start_quest"; questId: string }
  | { kind: "sessions_page"; page: number }
  | { kind: "session"; sessionId: string }
  | { kind: "manage"; sessionId: string; stateVersion: number }
  | { kind: "history_page"; sessionId: string; stateVersion: number; page: number }
  | { kind: "history_target"; sessionId: string; stateVersion: number; targetStepNo: number }
  | { kind: "pause"; sessionId: string; stateVersion: number }
  | { kind: "resume"; sessionId: string; stateVersion: number }
  | { kind: "stop_prompt"; sessionId: string; stateVersion: number }
  | { kind: "restart_prompt"; sessionId: string; stateVersion: number }
  | { kind: "noop" };

export interface MenuButton {
  text: string;
  action: MenuAction;
}

export interface MenuView {
  content: ContentView;
  rows: MenuButton[][];
}

const GENRE_EMOJI: Readonly<Record<string, string>> = {
  "Приключения": "🧭",
  "Детектив": "🕵️",
  "Мистика": "🧩",
  "Ужасы": "👻",
  "Хоррор": "👻",
  "Ужасы/Хоррор": "👻",
  "Фэнтези": "🗡️",
  "Тёмное фэнтези": "🌑",
  "Фантастика": "🚀",
  "Киберпанк": "🤖",
};

export function genreLabel(name: string): string {
  return `${GENRE_EMOJI[name] ?? "📖"} ${name}`;
}

export function pageButtons(page: number, totalPages: number): MenuButton[] {
  if (totalPages < 1) return [];
  const button = (text: string): MenuButton => ({ text, action: { kind: "noop" } });
  return [
    button("◀"),
    button(`${page} / ${totalPages}`),
    button("▶"),
  ];
}

function pagerRow(page: number, totalPages: number, actionForPage: (page: number) => MenuAction): MenuButton[] {
  return pageButtons(page, totalPages).map((button, index) => index === 0 && page > 1
    ? { ...button, action: actionForPage(page - 1) }
    : index === 2 && page < totalPages
      ? { ...button, action: actionForPage(page + 1) }
      : button);
}

function view(text: string, rows: MenuButton[][]): MenuView {
  return { content: { text }, rows };
}

export function mainMenuView(): MenuView {
  return view("Telegram Quest\nЛичный интерактивный рассказ. Выберите раздел.", [
    [{ text: "📚 Квесты", action: { kind: "quests_page", page: 1, genreKey: null, genrePage: 1 } }],
    [{ text: "🎭 Жанры", action: { kind: "genres_page", page: 1 } }],
    [{ text: "📖 Мои прохождения", action: { kind: "sessions_page", page: 1 } }],
  ]);
}

export function genreListView(page: Page<GenreEntry>): MenuView {
  const rows = page.items.map((genre): MenuButton[] => [{
    text: genreLabel(genre.name),
    action: { kind: "genre", key: genre.key, genrePage: page.page },
  }]);
  if (page.totalPages > 0) {
    rows.push(pagerRow(page.page, page.totalPages, (nextPage) => ({ kind: "genres_page", page: nextPage })));
  }
  rows.push([{ text: "⌂ В меню", action: { kind: "menu" } }]);
  return view(page.totalItems === 0 ? "Жанров пока нет." : "Выберите жанр.", rows);
}

export function questListView(
  page: Page<Quest>,
  genreKey: string | null,
  genrePage: number,
): MenuView {
  const rows = page.items.map((quest): MenuButton[] => [{
    text: quest.title,
    action: { kind: "quest_card", questId: quest.id, catalogPage: page.page, genreKey, genrePage },
  }]);
  if (page.totalPages > 0) {
    rows.push(pagerRow(page.page, page.totalPages, (nextPage) => ({ kind: "quests_page", page: nextPage, genreKey, genrePage })));
  }
  if (genreKey !== null) rows.push([{ text: "← К жанрам", action: { kind: "genres_page", page: genrePage } }]);
  rows.push([{ text: "⌂ В меню", action: { kind: "menu" } }]);
  return view(page.totalItems === 0 ? "Квестов пока нет." : "Выберите квест.", rows);
}

export function questCardView(
  quest: Quest,
  catalogPage: number,
  genreKey: string | null,
  genrePage: number,
): MenuView {
  return view(`${quest.title}\nЖанр: ${quest.genre}\n\n${quest.description}`, [
    [{ text: "▶ Начать прохождение", action: { kind: "start_quest", questId: quest.id } }],
    [{ text: "← К квестам", action: { kind: "quests_page", page: catalogPage, genreKey, genrePage } }],
    [{ text: "⌂ В меню", action: { kind: "menu" } }],
  ]);
}

function sessionStatusLabel(status: OwnedSessionSummary["status"]): string {
  switch (status) {
    case "created": return "не начат";
    case "active": return "в процессе";
    case "paused": return "на паузе";
    case "completed": return "завершён";
  }
}

export function sessionsView(page: Page<OwnedSessionSummary>): MenuView {
  const rows = page.items.map((session): MenuButton[] => {
    const suffix = ` · ${session.id.slice(0, 8)}`;
    return [{
      text: `${session.questTitle}${suffix} · ${sessionStatusLabel(session.status)}`,
      action: { kind: "session", sessionId: session.id },
    }];
  });
  if (page.totalPages > 0) {
    rows.push(pagerRow(page.page, page.totalPages, (nextPage) => ({ kind: "sessions_page", page: nextPage })));
  }
  rows.push([{ text: "⌂ В меню", action: { kind: "menu" } }]);
  return view(page.totalItems === 0 ? "Личных прохождений пока нет." : "Ваши личные прохождения:", rows);
}

export function historyView(
  page: Page<TurnSummary>,
  sessionId: string,
  stateVersion: number,
  canRewind: boolean,
): MenuView {
  const rows = canRewind
    ? page.items.map((turn): MenuButton[] => [{
      text: `${turn.stepNumber}. ${turn.sceneText.replace(/\s+/g, " ").trim().slice(0, 48)}`,
      action: { kind: "history_target", sessionId, stateVersion, targetStepNo: turn.stepNumber },
    }])
    : [];
  if (page.totalPages > 0) {
    rows.push(pagerRow(page.page, page.totalPages, (nextPage) => ({ kind: "history_page", sessionId, stateVersion, page: nextPage })));
  }
  rows.push([{ text: "← К управлению", action: { kind: "manage", sessionId, stateVersion } }]);
  const historyText = page.items.map((turn) =>
    `${turn.stepNumber}. ${turn.sceneText.replace(/\s+/g, " ").trim().slice(0, 240)}`
  ).join("\n\n");
  return view(page.totalItems === 0 ? "История ходов пуста." : `История ходов:\n\n${historyText}`, rows);
}
