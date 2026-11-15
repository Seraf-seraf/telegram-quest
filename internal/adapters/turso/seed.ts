import { createHash } from "node:crypto";
import type { QuestVersion } from "../../domain/model.js";
import type { StorySource } from "../../app/story-source.js";
import type { SqlRow, TursoDatabase } from "./client.js";

const DEMO_QUEST = {
  id: "telegram-quest-demo",
  title: "Две двери",
  description: "Короткий демонстрационный квест с двумя ветвями и финалами.",
  genre: "Приключения",
  available: 1,
} as const;

const DEMO_QUEST_VERSION: QuestVersion = {
  id: "telegram-quest-demo-v1",
  questId: DEMO_QUEST.id,
  version: "1.0.0",
  storyReference: "bundled:telegram-quest-demo-v1",
  storyHash: "0".repeat(64),
};

export class DemoCatalogConflictError extends Error {
  public constructor() {
    super("Bundled demo catalog conflicts with stored data.");
    this.name = "DemoCatalogConflictError";
  }
}

function matchesQuest(row: SqlRow): boolean {
  return row.id === DEMO_QUEST.id &&
    row.title === DEMO_QUEST.title &&
    row.description === DEMO_QUEST.description &&
    row.genre === DEMO_QUEST.genre &&
    Number(row.available) === DEMO_QUEST.available;
}

function matchesQuestVersion(row: SqlRow, storyHash: string): boolean {
  return row.id === DEMO_QUEST_VERSION.id &&
    row.quest_id === DEMO_QUEST_VERSION.questId &&
    row.version === DEMO_QUEST_VERSION.version &&
    row.story_ref === DEMO_QUEST_VERSION.storyReference &&
    typeof row.story_hash === "string" &&
    row.story_hash.toLowerCase() === storyHash;
}

export async function ensureDemoCatalog(
  database: TursoDatabase,
  storySource: StorySource,
): Promise<void> {
  const compiledStoryJson = await storySource.load({ ...DEMO_QUEST_VERSION });
  if (typeof compiledStoryJson !== "string") {
    throw new Error("Bundled demo story source returned invalid content.");
  }

  const normalizedStoryJson = compiledStoryJson.replace(/^\uFEFF/, "");
  const storyHash = createHash("sha256").update(normalizedStoryJson).digest("hex");

  await database.write(async (executor) => {
    const questRow = await executor.get(
      "SELECT id, title, description, genre, available FROM quest WHERE id = ?",
      DEMO_QUEST.id,
    );
    const versionRows = await executor.all(
      `SELECT id, quest_id, version, story_ref, story_hash
         FROM quest_version
        WHERE id = ? OR (quest_id = ? AND version = ?)`,
      DEMO_QUEST_VERSION.id,
      DEMO_QUEST_VERSION.questId,
      DEMO_QUEST_VERSION.version,
    );

    if (questRow !== undefined && !matchesQuest(questRow)) {
      throw new DemoCatalogConflictError();
    }

    if (versionRows.length > 1 ||
      (versionRows.length === 1 && !matchesQuestVersion(versionRows[0]!, storyHash))) {
      throw new DemoCatalogConflictError();
    }

    if (questRow === undefined && versionRows.length > 0) {
      throw new DemoCatalogConflictError();
    }

    if (questRow === undefined) {
      await executor.run(
        `INSERT INTO quest (id, title, description, genre, available)
         VALUES (?, ?, ?, ?, ?)`,
        DEMO_QUEST.id,
        DEMO_QUEST.title,
        DEMO_QUEST.description,
        DEMO_QUEST.genre,
        DEMO_QUEST.available,
      );
    }

    if (versionRows.length === 0) {
      await executor.run(
        `INSERT INTO quest_version (id, quest_id, version, story_ref, story_hash)
         VALUES (?, ?, ?, ?, ?)`,
        DEMO_QUEST_VERSION.id,
        DEMO_QUEST_VERSION.questId,
        DEMO_QUEST_VERSION.version,
        DEMO_QUEST_VERSION.storyReference,
        storyHash,
      );
    }
  });
}
