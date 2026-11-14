import { readFileSync } from "node:fs";
import { Story } from "inkjs";
import type { Choice as InkChoice } from "inkjs/engine/Choice";
import { describe, expect, it } from "vitest";
import {
  StoryRuntimeError,
  type StoryRuntimeErrorCode,
  type StoryStep,
} from "../../app/story.js";
import { InkStoryRuntime } from "./runtime.js";

const compiledStoryJson = readFileSync(
  new URL("./fixtures/demo.ink.json", import.meta.url),
  "utf8",
);

function readInkStep(story: Story): StoryStep {
  const tags: string[] = [];
  story.onDidContinue = (): void => {
    tags.push(...(story.currentTags ?? []));
  };
  const text = story.ContinueMaximally();
  story.onDidContinue = null;

  const choices = story.currentChoices.map((choice: InkChoice) => ({
    index: choice.index,
    text: choice.text,
    tags: [...(choice.tags ?? [])],
  }));

  return {
    text,
    choices,
    tags,
    stateJson: story.state.ToJson(),
    ended: choices.length === 0 && !story.canContinue,
  };
}

function expectStoryError(
  operation: () => unknown,
  code: StoryRuntimeErrorCode,
): void {
  let thrownError: unknown;
  try {
    operation();
  } catch (error) {
    thrownError = error;
  }

  expect(thrownError).toBeInstanceOf(StoryRuntimeError);
  expect(thrownError).toMatchObject({ code });
}

function inkStateFromEnvelope(stateJson: string): string {
  const envelope = JSON.parse(stateJson) as { inkStateJson: string };
  return envelope.inkStateJson;
}

describe("InkStoryRuntime", (): void => {
  it("starts the compiled story with tagged choices", (): void => {
    const runtime = new InkStoryRuntime();
    const step = runtime.start(compiledStoryJson);

    expect(step.text).toBe("A sign points toward two doors.\n");
    expect(step.tags).toEqual(["scene:crossroads"]);
    expect(step.choices).toEqual([
      { index: 0, text: "Take the left path", tags: ["direction:left"] },
      { index: 1, text: "Take the right path", tags: ["direction:right"] },
    ]);
    expect(step.stateJson).toEqual(expect.any(String));
    expect(step.ended).toBe(false);
  });

  it.each([
    {
      index: 0,
      branchText: "The left path glows.",
      conditionText: "You followed the left sign.",
      branchTag: "route:left",
      endingText: "The left road leads home.",
      endingTag: "ending:left",
    },
    {
      index: 1,
      branchText: "The right path echoes.",
      conditionText: "You followed the right sign.",
      branchTag: "route:right",
      endingText: "The right road reaches the river.",
      endingTag: "ending:right",
    },
  ])("follows choice $index through its conditional ending", (scenario): void => {
    const runtime = new InkStoryRuntime();
    const initial = runtime.start(compiledStoryJson);
    const branch = runtime.choose(compiledStoryJson, initial.stateJson, scenario.index);

    expect(branch.text).toContain(scenario.branchText);
    expect(branch.text).toContain(scenario.conditionText);
    expect(branch.tags).toContain(scenario.branchTag);
    expect(branch.choices).toHaveLength(2);
    expect(branch.ended).toBe(false);

    const ending = runtime.choose(compiledStoryJson, branch.stateJson, 0);

    expect(ending.text).toContain(scenario.endingText);
    expect(ending.tags).toContain(scenario.endingTag);
    expect(ending.choices).toEqual([]);
    expect(ending.ended).toBe(true);
  });

  it("resumes a saved state on fresh Stories with the same random progression", (): void => {
    const initial = new InkStoryRuntime().start(compiledStoryJson);
    const originalStateJson = initial.stateJson;
    const uninterrupted = new Story(compiledStoryJson.replace(/^\uFEFF/, ""));
    uninterrupted.state.LoadJson(inkStateFromEnvelope(initial.stateJson));
    uninterrupted.ChooseChoiceIndex(0);
    const expectedBranch = readInkStep(uninterrupted);

    const branch = new InkStoryRuntime().choose(
      compiledStoryJson,
      initial.stateJson,
      0,
    );
    const repeatedBranch = new InkStoryRuntime().choose(
      compiledStoryJson,
      initial.stateJson,
      0,
    );

    expect(branch).toMatchObject({
      text: expectedBranch.text,
      choices: expectedBranch.choices,
      tags: expectedBranch.tags,
      ended: expectedBranch.ended,
    });
    expect(JSON.parse(inkStateFromEnvelope(branch.stateJson))).toEqual(
      JSON.parse(expectedBranch.stateJson),
    );
    expect(repeatedBranch).toEqual(branch);
    expect(initial.stateJson).toBe(originalStateJson);

    uninterrupted.ChooseChoiceIndex(0);
    const expectedEnding = readInkStep(uninterrupted);
    const ending = new InkStoryRuntime().choose(
      compiledStoryJson,
      branch.stateJson,
      0,
    );

    expect(ending).toMatchObject({
      text: expectedEnding.text,
      choices: expectedEnding.choices,
      tags: expectedEnding.tags,
      ended: expectedEnding.ended,
    });
    expect(JSON.parse(inkStateFromEnvelope(ending.stateJson))).toEqual(
      JSON.parse(expectedEnding.stateJson),
    );
  });

  it("rejects malformed and incompatible story state", (): void => {
    const runtime = new InkStoryRuntime();
    const initial = runtime.start(compiledStoryJson);
    const stateEnvelope = JSON.parse(initial.stateJson) as {
      formatVersion: number;
      storyFingerprint: string;
      inkStateJson: string;
    };
    const incompatibleInkState = JSON.parse(stateEnvelope.inkStateJson) as Record<
      string,
      unknown
    >;
    incompatibleInkState.inkSaveVersion = 999;

    expectStoryError(() => runtime.start("not JSON"), "INVALID_STORY");
    expectStoryError(
      () => runtime.choose(compiledStoryJson, "not JSON", 0),
      "INVALID_STATE",
    );
    expectStoryError(
      () => runtime.choose(
        compiledStoryJson,
        JSON.stringify({
          ...stateEnvelope,
          inkStateJson: JSON.stringify(incompatibleInkState),
        }),
        0,
      ),
      "INVALID_STATE",
    );
  });

  it("rejects state created for different compiled story content", (): void => {
    const runtime = new InkStoryRuntime();
    const initial = runtime.start(compiledStoryJson);
    const changedStoryJson = compiledStoryJson.replace(
      "The left path glows.",
      "A changed left path glows.",
    );

    expect(changedStoryJson).not.toBe(compiledStoryJson);
    expectStoryError(
      () => runtime.choose(changedStoryJson, initial.stateJson, 0),
      "INVALID_STATE",
    );
  });

  it("rejects unavailable and non-integer choice indexes", (): void => {
    const runtime = new InkStoryRuntime();
    const initial = runtime.start(compiledStoryJson);

    for (const choiceIndex of [-1, 2, 0.5, Number.NaN]) {
      expectStoryError(
        () => runtime.choose(compiledStoryJson, initial.stateJson, choiceIndex),
        "INVALID_CHOICE",
      );
    }
  });

  it("rejects a choice after the story has ended", (): void => {
    const runtime = new InkStoryRuntime();
    const initial = runtime.start(compiledStoryJson);
    const branch = runtime.choose(compiledStoryJson, initial.stateJson, 0);
    const ending = runtime.choose(compiledStoryJson, branch.stateJson, 0);

    expectStoryError(
      () => runtime.choose(compiledStoryJson, ending.stateJson, 0),
      "STORY_ENDED",
    );
  });
});
