import demoStory from "../ink/fixtures/demo.ink.json" with { type: "json" };
import type { TursoDatabase } from "./client.js";

const DEMO_QUEST = {
  id: "telegram-quest-demo",
  title: "Две двери",
  description: "Короткий демонстрационный квест с двумя ветвями и финалами.",
  genre: "Приключения",
  available: 1,
} as const;

export async function ensureDemoCatalog(database: TursoDatabase): Promise<void> {
  const storyJson = JSON.stringify(demoStory);

  await database.write(async (executor) => {
    const existingQuest = await executor.get(
      "SELECT id FROM quest WHERE id = ?",
      DEMO_QUEST.id,
    );
    if (existingQuest !== undefined) {
      return;
    }

    await executor.run(
      `INSERT INTO quest (id, title, description, genre, available, story_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      DEMO_QUEST.id,
      DEMO_QUEST.title,
      DEMO_QUEST.description,
      DEMO_QUEST.genre,
      DEMO_QUEST.available,
      storyJson,
    );
  });
}
