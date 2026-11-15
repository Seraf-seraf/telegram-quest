import type { Quest } from "../domain/model.js";

export interface PublishedMetadataValue {
  kind: "image" | "text";
  value: string;
}

export interface MetadataUpdate {
  name: string;
  value: PublishedMetadataValue | null;
}

export interface QuestPublicationPort {
  publishQuest(
    quest: Quest,
    storyJson: string,
    metadata?: readonly MetadataUpdate[],
  ): Promise<void>;
  updateQuestMetadata(
    quest: Quest,
    metadata?: readonly MetadataUpdate[],
  ): Promise<void>;
  publishMenu(metadata: readonly MetadataUpdate[]): Promise<void>;
}

export type PublicationRequest =
  | { mode: "full"; manifest: unknown; storyJson: unknown }
  | { mode: "metadata-only"; manifest: unknown }
  | { mode: "menu"; manifest: unknown };

export type PublicationPlan =
  | {
    mode: "full";
    quest: Quest;
    storyJson: string;
    metadata?: MetadataUpdate[];
  }
  | {
    mode: "metadata-only";
    quest: Quest;
    metadata?: MetadataUpdate[];
  }
  | { mode: "menu"; metadata: MetadataUpdate[] };

export class PublicationInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublicationInputError";
  }
}

const questIdPattern = /^[a-z0-9_-]{1,32}$/;
const metadataNamePattern = /^[a-z0-9_.-]{1,64}$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicationInputError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new PublicationInputError(`${label} contains an unsupported field.`);
  }
}

function validateQuestId(value: unknown): string {
  if (typeof value !== "string" || !questIdPattern.test(value)) {
    throw new PublicationInputError(
      "Quest id must contain 1 to 32 lowercase ASCII letters, digits, underscores, or hyphens.",
    );
  }
  return value;
}

function validateMetadataName(value: string): string {
  if (!metadataNamePattern.test(value)) {
    throw new PublicationInputError(
      "Metadata names must contain 1 to 64 lowercase ASCII letters, digits, underscores, dots, or hyphens.",
    );
  }
  return value;
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      hostname.length > 0 &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal");
  } catch {
    return false;
  }
}

function parseMetadata(value: unknown): MetadataUpdate[] {
  const record = asRecord(value, "metadata");
  const changes: MetadataUpdate[] = [];

  for (const [name, metadataValue] of Object.entries(record)) {
    validateMetadataName(name);
    if (metadataValue === null) {
      changes.push({ name, value: null });
      continue;
    }

    const item = asRecord(metadataValue, `metadata.${name}`);
    assertOnlyKeys(item, ["kind", "value"], `metadata.${name}`);
    if (item.kind !== "image" && item.kind !== "text") {
      throw new PublicationInputError(`metadata.${name}.kind is unsupported.`);
    }
    if (typeof item.value !== "string") {
      throw new PublicationInputError(`metadata.${name}.value must be a string.`);
    }
    if (item.kind === "image" && !isAllowedImageUrl(item.value)) {
      throw new PublicationInputError(
        `metadata.${name}.value must be an HTTPS URL without credentials or a local hostname.`,
      );
    }

    changes.push({ name, value: { kind: item.kind, value: item.value } });
  }

  return changes;
}

function readQuestManifest(value: unknown): {
  quest: Quest;
  metadata?: MetadataUpdate[];
} {
  const manifest = asRecord(value, "quest.json");
  assertOnlyKeys(
    manifest,
    ["id", "title", "description", "genre", "available", "metadata"],
    "quest.json",
  );

  const id = validateQuestId(manifest.id);
  if (typeof manifest.title !== "string" || manifest.title.trim().length === 0) {
    throw new PublicationInputError("Quest title must not be empty.");
  }
  if (typeof manifest.description !== "string") {
    throw new PublicationInputError("Quest description must be a string.");
  }
  if (typeof manifest.genre !== "string") {
    throw new PublicationInputError("Quest genre must be a string.");
  }
  if (typeof manifest.available !== "boolean") {
    throw new PublicationInputError("Quest available must be a boolean.");
  }

  const quest: Quest = {
    id,
    title: manifest.title,
    description: manifest.description,
    genre: manifest.genre,
    available: manifest.available,
  };
  if (!Object.hasOwn(manifest, "metadata")) {
    return { quest };
  }

  return { quest, metadata: parseMetadata(manifest.metadata) };
}

function validateCompiledStory(value: unknown): string {
  if (typeof value !== "string") {
    throw new PublicationInputError("Compiled Ink story must be a JSON string.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PublicationInputError("Compiled Ink story must contain valid JSON.");
  }
  const story = asRecord(parsed, "Compiled Ink story");
  if (
    typeof story.inkVersion !== "number" ||
    !Number.isSafeInteger(story.inkVersion) ||
    !Array.isArray(story.root) ||
    typeof story.listDefs !== "object" ||
    story.listDefs === null ||
    Array.isArray(story.listDefs)
  ) {
    throw new PublicationInputError("Compiled Ink story has an unsupported format.");
  }
  return value;
}

export function preparePublication(request: PublicationRequest): PublicationPlan {
  switch (request.mode) {
    case "full": {
      const manifest = readQuestManifest(request.manifest);
      return {
        mode: "full",
        quest: manifest.quest,
        storyJson: validateCompiledStory(request.storyJson),
        ...(manifest.metadata === undefined ? {} : { metadata: manifest.metadata }),
      };
    }
    case "metadata-only": {
      const manifest = readQuestManifest(request.manifest);
      return {
        mode: "metadata-only",
        quest: manifest.quest,
        ...(manifest.metadata === undefined ? {} : { metadata: manifest.metadata }),
      };
    }
    case "menu": {
      const manifest = asRecord(request.manifest, "menu file");
      assertOnlyKeys(manifest, ["metadata"], "menu file");
      if (!Object.hasOwn(manifest, "metadata")) {
        throw new PublicationInputError("menu file must contain metadata.");
      }
      return { mode: "menu", metadata: parseMetadata(manifest.metadata) };
    }
  }
}

export async function applyPublicationPlan(
  publisher: QuestPublicationPort,
  plan: PublicationPlan,
): Promise<void> {
  switch (plan.mode) {
    case "full":
      await publisher.publishQuest(plan.quest, plan.storyJson, plan.metadata);
      return;
    case "metadata-only":
      await publisher.updateQuestMetadata(plan.quest, plan.metadata);
      return;
    case "menu":
      await publisher.publishMenu(plan.metadata);
      return;
  }
}
