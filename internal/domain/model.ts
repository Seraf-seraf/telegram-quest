export interface Quest {
  id: string;
  title: string;
  description: string;
  genre: string;
  available: boolean;
}

export interface QuestVersion {
  id: string;
  questId: string;
  version: string;
  storyReference: string;
  storyHash: string;
}

export type SessionOwner =
  | { type: "group"; id: string }
  | { type: "user"; id: string };

export type SessionStatus = "created" | "active" | "paused" | "completed";

export type InkState = string;

export interface Choice {
  index: number;
  text: string;
  tags: string[];
}
export type Outcome = string;

export interface Decision {
  choiceIndex: number;
}

export interface Turn {
  id: string;
  stepNumber: number;
  inkCheckpoint: InkState;
  sceneText: string;
  choices: Choice[];
  decision: Decision | null;
}

export interface Session {
  id: string;
  questVersionId: string;
  owner: SessionOwner;
  status: SessionStatus;
  inkState: InkState | null;
  stateVersion: number;
  turns: Turn[];
  outcome: Outcome | null;
}
