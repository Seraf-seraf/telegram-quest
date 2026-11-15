import type { Quest } from "../domain/model.js";

export interface QuestCatalog {
  listAvailableQuests(): Promise<Quest[]>;
  getQuest(questId: string): Promise<Quest | null>;
}
