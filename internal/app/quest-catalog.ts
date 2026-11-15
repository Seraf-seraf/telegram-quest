import type { Quest, QuestVersion } from "../domain/model.js";

export interface QuestCatalog {
  listAvailableQuests(): Promise<Quest[]>;
  listVersions(questId: string): Promise<QuestVersion[]>;
  getQuestVersion(questVersionId: string): Promise<QuestVersion | null>;
}
