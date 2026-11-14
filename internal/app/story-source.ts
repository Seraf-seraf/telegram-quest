import type { QuestVersion } from "../domain/model.js";

export type StorySourceErrorCode = "NOT_FOUND" | "STORAGE_FAILURE";

export class StorySourceError extends Error {
  public constructor(
    public readonly code: StorySourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorySourceError";
  }
}

export interface StorySource {
  load(questVersion: QuestVersion): Promise<string>;
}
