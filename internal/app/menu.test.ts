import { describe, expect, it } from "vitest";
import {
  genreLabel,
  genreListView,
  historyView,
  mainMenuView,
  pageButtons,
  questCardView,
  questListView,
  sessionsView,
} from "./menu.js";

describe("menu views", () => {
  it("builds a vertical main menu and a single horizontal pager including 1/1", () => {
    const main = mainMenuView();
    expect(main.rows.map((row) => row.length)).toEqual([1, 1, 1]);
    expect(main.rows.map((row) => row[0]?.text)).toEqual([
      "📚 Квесты", "🎭 Жанры", "📖 Мои прохождения",
    ]);
    expect(pageButtons(1, 1).map((button) => button.text)).toEqual(["◀", "1 / 1", "▶"]);
    expect(pageButtons(1, 1).every((button) => button.action.kind === "noop")).toBe(true);
    expect(pageButtons(2, 3).map((button) => button.text)).toEqual(["◀", "2 / 3", "▶"]);
    expect(pageButtons(1, 0)).toEqual([]);
  });

  it("labels real genres without changing their stored names", () => {
    expect(genreLabel("Приключения")).toBe("🧭 Приключения");
    expect(genreLabel("Неизвестный жанр")).toBe("📖 Неизвестный жанр");
    const view = genreListView({ items: [{ name: "Приключения", key: "abcdefghijk" }], page: 1, totalItems: 1, totalPages: 1 });
    expect(view.rows[0]?.[0]).toMatchObject({ text: "🧭 Приключения", action: { kind: "genre", key: "abcdefghijk", genrePage: 1 } });
    expect(view.rows[1]?.map((button) => button.text)).toEqual(["◀", "1 / 1", "▶"]);
    expect(view.rows[2]?.[0]?.text).toBe("⌂ В меню");
  });

  it("preserves list, card, session and history navigation context", () => {
    const quest = { id: "two-doors", title: "Две двери", genre: "Приключения", description: "Текст", available: true };
    expect(questListView({ items: [quest], page: 2, totalItems: 6, totalPages: 2 }, "abcdefghijk", 3)
      .rows[0]?.[0]?.action).toEqual({ kind: "quest_card", questId: "two-doors", catalogPage: 2, genreKey: "abcdefghijk", genrePage: 3 });
    expect(questCardView(quest, 2, "abcdefghijk", 3).rows[1]?.[0]?.action)
      .toEqual({ kind: "quests_page", page: 2, genreKey: "abcdefghijk", genrePage: 3 });
    const session = { id: "session-123", questId: quest.id, questTitle: quest.title, status: "active" as const, stateVersion: 4 };
    expect(sessionsView({ items: [session], page: 1, totalItems: 1, totalPages: 1 }).rows[0]?.[0]?.action)
      .toEqual({ kind: "session", sessionId: session.id });
    expect(historyView({ items: [{ stepNumber: 2, sceneText: "Текст сцены" }], page: 1, totalItems: 1, totalPages: 1 }, session.id, 4, true)
      .rows[0]?.[0]?.action).toEqual({ kind: "history_target", sessionId: session.id, stateVersion: 4, targetStepNo: 2 });
    expect(historyView({ items: [{ stepNumber: 2, sceneText: "Текст сцены" }], page: 1, totalItems: 1, totalPages: 1 }, session.id, 4, false)
      .rows.some((row) => row.some((button) => button.action.kind === "history_target"))).toBe(false);
  });
});
