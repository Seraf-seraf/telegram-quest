import type { Choice, InkState } from "../domain/model.js";

export type StoryRuntimeErrorCode =
  | "INVALID_STORY"
  | "INVALID_STATE"
  | "INVALID_CHOICE"
  | "STORY_ENDED";

export class StoryRuntimeError extends Error {
  public constructor(
    public readonly code: StoryRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoryRuntimeError";
  }
}

export interface StoryStep {
  text: string;
  choices: Choice[];
  tags: string[];
  stateJson: InkState;
  ended: boolean;
}

export interface StoryRuntime {
  start(compiledStoryJson: string): StoryStep;
  choose(
    compiledStoryJson: string,
    savedStateJson: InkState,
    choiceIndex: number,
  ): StoryStep;
}
