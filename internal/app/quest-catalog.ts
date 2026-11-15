import type { Quest } from "../domain/model.js";
import type { Page } from "./pagination.js";

export interface GenreEntry {
  name: string;
  key: string;
}

export interface QuestCatalog {
  listAvailableQuests(): Promise<Quest[]>;
  listQuestsPage(page: number, genre?: string): Promise<Page<Quest>>;
  listGenresPage(page: number): Promise<Page<GenreEntry>>;
  resolveGenreKey(key: string): Promise<string | null>;
  getQuest(questId: string): Promise<Quest | null>;
}
