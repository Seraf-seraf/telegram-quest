import { Story } from "inkjs";
import type { Choice as InkChoice } from "inkjs/engine/Choice";
import type { Choice, InkState } from "../../domain/model.js";
import {
  StoryRuntimeError,
  type StoryRuntime,
  type StoryRuntimeErrorCode,
  type StoryStep,
} from "../../app/story.js";

export class InkStoryRuntime implements StoryRuntime {
  public start(compiledStoryJson: string): StoryStep {
    const story = this.createStory(compiledStoryJson);
    return this.createStep(story, "INVALID_STORY");
  }

  public choose(
    compiledStoryJson: string,
    savedStateJson: InkState,
    choiceIndex: number,
  ): StoryStep {
    const story = this.createStory(compiledStoryJson);
    this.validateInkState(story, savedStateJson);

    try {
      story.state.LoadJson(savedStateJson);
    } catch {
      throw new StoryRuntimeError("INVALID_STATE", "Saved Ink state is invalid.");
    }

    if (story.hasError) {
      throw new StoryRuntimeError("INVALID_STATE", "Saved Ink state is invalid.");
    }

    const availableChoices = story.currentChoices;
    if (availableChoices.length === 0 && !story.canContinue) {
      throw new StoryRuntimeError("STORY_ENDED", "The Ink story has ended.");
    }

    if (
      !Number.isInteger(choiceIndex) ||
      !availableChoices.some((choice: InkChoice) => choice.index === choiceIndex)
    ) {
      throw new StoryRuntimeError("INVALID_CHOICE", "The Ink choice is unavailable.");
    }

    try {
      story.ChooseChoiceIndex(choiceIndex);
    } catch {
      throw new StoryRuntimeError("INVALID_CHOICE", "The Ink choice is unavailable.");
    }

    if (story.hasError) {
      throw new StoryRuntimeError("INVALID_STORY", "The compiled Ink story is invalid.");
    }

    return this.createStep(story, "INVALID_STATE");
  }

  private createStory(compiledStoryJson: string): Story {
    try {
      const story = new Story(compiledStoryJson.replace(/^\uFEFF/, ""));
      if (story.hasError) {
        throw new Error("Ink story reported an error during construction.");
      }
      return story;
    } catch {
      throw new StoryRuntimeError("INVALID_STORY", "The compiled Ink story is invalid.");
    }
  }

  private validateInkState(story: Story, inkStateJson: InkState): void {
    let inkState: unknown;
    try {
      inkState = JSON.parse(inkStateJson);
    } catch {
      throw new StoryRuntimeError("INVALID_STATE", "Saved Ink state is invalid.");
    }

    if (
      typeof inkState !== "object" ||
      inkState === null ||
      Array.isArray(inkState)
    ) {
      throw new StoryRuntimeError("INVALID_STATE", "Saved Ink state is invalid.");
    }

    const stateObject = inkState as Record<string, unknown>;
    const saveVersion = stateObject.inkSaveVersion;
    const inkFormatVersion = stateObject.inkFormatVersion;
    if (
      typeof saveVersion !== "number" ||
      !Number.isInteger(saveVersion) ||
      saveVersion < story.state.kMinCompatibleLoadVersion ||
      saveVersion > story.state.kInkSaveStateVersion ||
      typeof inkFormatVersion !== "number" ||
      !Number.isInteger(inkFormatVersion) ||
      inkFormatVersion < story.inkVersionMinimumCompatible ||
      inkFormatVersion > Story.inkVersionCurrent
    ) {
      throw new StoryRuntimeError("INVALID_STATE", "Saved Ink state is incompatible.");
    }
  }

  private createStep(
    story: Story,
    failureCode: StoryRuntimeErrorCode,
  ): StoryStep {
    const tags: string[] = [];
    story.onDidContinue = (): void => {
      tags.push(...(story.currentTags ?? []));
    };

    let text: string;
    try {
      text = story.ContinueMaximally();
      if (story.hasError) {
        throw new Error("Ink story reported an error while continuing.");
      }
    } catch {
      throw new StoryRuntimeError(failureCode, "The Ink story could not continue.");
    } finally {
      story.onDidContinue = null;
    }

    const choices: Choice[] = story.currentChoices.map((choice: InkChoice) => ({
      index: choice.index,
      text: choice.text,
      tags: [...(choice.tags ?? [])],
    }));

    let inkStateJson: InkState;
    try {
      inkStateJson = story.state.ToJson();
    } catch {
      throw new StoryRuntimeError(failureCode, "The Ink story state could not be saved.");
    }

    return {
      text,
      choices,
      tags,
      stateJson: inkStateJson,
      ended: choices.length === 0 && !story.canContinue,
    };
  }
}
