import type { Quest } from "../../domain/model.js";
import type {
  MetadataUpdate,
  QuestPublicationPort,
} from "../../app/publish-quest.js";
import type { SqlExecutor, TursoDatabase } from "./client.js";

async function writeMetadataUpdates(
  executor: SqlExecutor,
  questId: string | null,
  updates: readonly MetadataUpdate[],
): Promise<void> {
  for (const update of updates) {
    if (update.value === null) {
      if (questId === null) {
        await executor.run(
          "DELETE FROM content_metadata WHERE quest_id IS NULL AND name = ?",
          update.name,
        );
      } else {
        await executor.run(
          "DELETE FROM content_metadata WHERE quest_id = ? AND name = ?",
          questId,
          update.name,
        );
      }
      continue;
    }

    const existing = questId === null
      ? await executor.get(
        "SELECT id FROM content_metadata WHERE quest_id IS NULL AND name = ?",
        update.name,
      )
      : await executor.get(
        "SELECT id FROM content_metadata WHERE quest_id = ? AND name = ?",
        questId,
        update.name,
      );

    if (existing === undefined) {
      await executor.run(
        `INSERT INTO content_metadata (quest_id, name, kind, value)
         VALUES (?, ?, ?, ?)`,
        questId,
        update.name,
        update.value.kind,
        update.value.value,
      );
    } else {
      if (questId === null) {
        await executor.run(
          `UPDATE content_metadata
              SET kind = ?, value = ?
            WHERE quest_id IS NULL AND name = ?`,
          update.value.kind,
          update.value.value,
          update.name,
        );
      } else {
        await executor.run(
          `UPDATE content_metadata
              SET kind = ?, value = ?
            WHERE quest_id = ? AND name = ?`,
          update.value.kind,
          update.value.value,
          questId,
          update.name,
        );
      }
    }
  }
}

async function updateQuestFields(executor: SqlExecutor, quest: Quest): Promise<void> {
  await executor.run(
    `UPDATE quest
        SET title = ?, description = ?, genre = ?, available = ?
      WHERE id = ?`,
    quest.title,
    quest.description,
    quest.genre,
    quest.available ? 1 : 0,
    quest.id,
  );
}

export function createTursoQuestPublisher(database: TursoDatabase): QuestPublicationPort {
  return {
    async publishQuest(
      quest: Quest,
      storyJson: string,
      metadata?: readonly MetadataUpdate[],
    ): Promise<void> {
      await database.write(async (executor) => {
        await executor.run(
          `INSERT INTO quest (id, title, description, genre, available, story_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             genre = excluded.genre,
             available = excluded.available,
             story_json = excluded.story_json`,
          quest.id,
          quest.title,
          quest.description,
          quest.genre,
          quest.available ? 1 : 0,
          storyJson,
        );

        if (metadata !== undefined) {
          await writeMetadataUpdates(executor, quest.id, metadata);
        }
      });
    },

    async updateQuestMetadata(
      quest: Quest,
      metadata?: readonly MetadataUpdate[],
    ): Promise<void> {
      await database.write(async (executor) => {
        const existing = await executor.get(
          "SELECT id FROM quest WHERE id = ?",
          quest.id,
        );
        if (existing === undefined) {
          throw new Error("Quest was not found for metadata-only publication.");
        }

        await updateQuestFields(executor, quest);
        if (metadata !== undefined) {
          await writeMetadataUpdates(executor, quest.id, metadata);
        }
      });
    },

    async publishMenu(metadata: readonly MetadataUpdate[]): Promise<void> {
      await database.write((executor) =>
        writeMetadataUpdates(executor, null, metadata)
      );
    },
  };
}
