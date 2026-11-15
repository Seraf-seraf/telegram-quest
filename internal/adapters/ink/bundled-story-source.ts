import demoStory from "./fixtures/demo.ink.json" with { type: "json" };
import { StorySourceError, type StorySource } from "../../app/story-source.js";
import type { QuestVersion } from "../../domain/model.js";

const BUNDLED_DEMO_STORY_REFERENCE = "bundled:telegram-quest-demo-v1";

export class BundledStorySource implements StorySource {
  private readonly compiledStoryJson = JSON.stringify(demoStory);

  public async load(questVersion: QuestVersion): Promise<string> {
    if (questVersion.storyReference !== BUNDLED_DEMO_STORY_REFERENCE) {
      throw new StorySourceError("NOT_FOUND", "Quest story was not found.");
    }

    if (this.compiledStoryJson === undefined) {
      throw new StorySourceError("STORAGE_FAILURE", "Bundled quest story is unavailable.");
    }

    return this.compiledStoryJson;
  }
}
