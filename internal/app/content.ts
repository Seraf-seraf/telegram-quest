import type { MetadataStore } from "./metadata.js";

export interface ContentView {
  text: string;
  imageUrl?: string;
}

export type ContentResolver = (
  questId: string | null,
  originalText: string,
  references: readonly string[],
) => Promise<ContentView>;

export type ContentDiagnosticCode =
  | "METADATA_READ_FAILED"
  | "METADATA_MISSING"
  | "METADATA_INVALID"
  | "METADATA_UNSUPPORTED";

export interface ContentDiagnosticEvent {
  event: "telegram_quest.content_metadata_unavailable";
  questId: string | null;
  name: string | null;
  code: ContentDiagnosticCode;
}

export type ContentDiagnosticSink = (event: ContentDiagnosticEvent) => void;

function reportDiagnostic(
  sink: ContentDiagnosticSink,
  event: ContentDiagnosticEvent,
): void {
  try {
    sink(event);
  } catch {
    // Decorative content must not interfere with the story action.
  }
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

export function assetReferences(tags: readonly string[]): string[] {
  const prefix = "asset:";
  return tags.flatMap((tag) =>
    tag.startsWith(prefix) && tag.length > prefix.length
      ? [tag.slice(prefix.length)]
      : []
  );
}

export async function resolveContent(
  store: MetadataStore,
  questId: string | null,
  originalText: string,
  references: readonly string[],
  logDiagnostic: ContentDiagnosticSink,
): Promise<ContentView> {
  const names = [...new Set(references)];
  if (names.length === 0) {
    return { text: originalText };
  }

  let records;
  try {
    records = await store.getMany(questId, names);
  } catch {
    reportDiagnostic(logDiagnostic, {
      event: "telegram_quest.content_metadata_unavailable",
      questId,
      name: null,
      code: "METADATA_READ_FAILED",
    });
    return { text: originalText };
  }

  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const textValues: string[] = [];
  let imageUrl: string | undefined;

  for (const name of names) {
    const record = recordsByName.get(name);
    if (record === undefined) {
      reportDiagnostic(logDiagnostic, {
        event: "telegram_quest.content_metadata_unavailable",
        questId,
        name,
        code: "METADATA_MISSING",
      });
      continue;
    }

    if (record.kind === "text") {
      textValues.push(record.value);
    } else if (record.kind === "image") {
      if (!isAllowedImageUrl(record.value)) {
        reportDiagnostic(logDiagnostic, {
          event: "telegram_quest.content_metadata_unavailable",
          questId,
          name,
          code: "METADATA_INVALID",
        });
      } else if (imageUrl === undefined) {
        imageUrl = record.value;
      }
    } else {
      reportDiagnostic(logDiagnostic, {
        event: "telegram_quest.content_metadata_unavailable",
        questId,
        name,
        code: "METADATA_UNSUPPORTED",
      });
    }
  }

  const nonEmptyTextValues = textValues.filter((value) => value.length > 0);
  const text = nonEmptyTextValues.length === 0
    ? originalText
    : [originalText, ...nonEmptyTextValues].filter((part) => part.length > 0).join("\n\n");

  return imageUrl === undefined ? { text } : { text, imageUrl };
}
