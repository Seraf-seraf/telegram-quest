import { describe, expect, it, vi } from "vitest";
import type { ContentMetadata, MetadataStore } from "./metadata.js";
import { assetReferences, resolveContent } from "./content.js";

function makeStore(entries: Record<string, ContentMetadata[]>): MetadataStore {
  return {
    async getMany(questId, names) {
      const available = entries[questId ?? "global"] ?? [];
      return available.filter((entry) => names.includes(entry.name));
    },
  };
}

describe("resolveContent", () => {
  it("extracts only asset scene tags and preserves their first reference order", () => {
    expect(assetReferences([
      "chapter:arrival",
      "asset:dark_corridor",
      "mood:quiet",
      "asset:corridor_note",
      "asset:dark_corridor",
      "asset:",
    ])).toEqual(["dark_corridor", "corridor_note", "dark_corridor"]);
  });

  it("uses reference order, one image, and text while reporting missing and unknown values safely", async () => {
    const log = vi.fn();
    const imageUrl = "https://cdn.example/images/corridor.jpg?token=private";
    const view = await resolveContent(
      makeStore({
        questA: [
          { name: "corridor_note", kind: "text", value: "A faint note is visible." },
          { name: "cover", kind: "image", value: imageUrl },
          { name: "dark_corridor", kind: "text", value: "The corridor is dark." },
          { name: "legacy", kind: "video", value: "private payload" },
        ],
      }),
      "questA",
      "The door opens.",
      ["dark_corridor", "cover", "corridor_note", "legacy", "missing", "cover"],
      log,
    );

    expect(view).toEqual({
      text: "The door opens.\n\nThe corridor is dark.\n\nA faint note is visible.",
      imageUrl,
    });
    expect(log).toHaveBeenCalledWith({
      event: "telegram_quest.content_metadata_unavailable",
      questId: "questA",
      name: "legacy",
      code: "METADATA_UNSUPPORTED",
    });
    expect(log).toHaveBeenCalledWith({
      event: "telegram_quest.content_metadata_unavailable",
      questId: "questA",
      name: "missing",
      code: "METADATA_MISSING",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ name: "cover" }));
  });

  it("uses exact quest namespaces and reads changed values again on the next call", async () => {
    const store: MetadataStore = {
      getMany: vi.fn(async (questId) => [{
        name: "dark_corridor",
        kind: "image",
        value: questId === "questA"
          ? "https://one.example/corridor.jpg"
          : "https://two.example/corridor.jpg",
      }]),
    };
    const log = vi.fn();

    const first = await resolveContent(store, "questA", "Door.", ["dark_corridor"], log);
    const otherQuest = await resolveContent(store, "questB", "Door.", ["dark_corridor"], log);
    expect(first.imageUrl).toBe("https://one.example/corridor.jpg");
    expect(otherQuest.imageUrl).toBe("https://two.example/corridor.jpg");

    let currentUrl = "https://one.example/first.jpg";
    store.getMany = vi.fn(async () => [{
      name: "dark_corridor",
      kind: "image",
      value: currentUrl,
    }]);
    expect((await resolveContent(store, "questA", "Door.", ["dark_corridor"], log)).imageUrl)
      .toBe(currentUrl);
    currentUrl = "https://one.example/updated.jpg";
    expect((await resolveContent(store, "questA", "Door.", ["dark_corridor"], log)).imageUrl)
      .toBe(currentUrl);
  });

  it("ignores invalid image URLs and returns original text when metadata reads fail", async () => {
    const log = vi.fn();
    const invalidImageStore = makeStore({
      questA: [
        { name: "http", kind: "image", value: "http://cdn.example.com/private.png" },
        { name: "local", kind: "image", value: "https://localhost/private.png" },
        { name: "auth-url", kind: "image", value: "https://user:secret@cdn.example.com/private.png" },
        { name: "malformed", kind: "image", value: "not an HTTPS URL" },
      ],
    });
    expect(await resolveContent(
      invalidImageStore,
      "questA",
      "Original scene.",
      ["http", "local", "auth-url", "malformed"],
      log,
    )).toEqual({ text: "Original scene." });
    expect(log).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("example.com");

    const failedStore: MetadataStore = {
      getMany: async () => {
        throw new Error("database credentials and URL");
      },
    };
    expect(await resolveContent(failedStore, "questA", "Still playable.", ["cover"], log))
      .toEqual({ text: "Still playable." });
    expect(log).toHaveBeenLastCalledWith({
      event: "telegram_quest.content_metadata_unavailable",
      questId: "questA",
      name: null,
      code: "METADATA_READ_FAILED",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("credentials");
  });

  it("does not read the store when there are no references", async () => {
    const store: MetadataStore = { getMany: vi.fn(async () => []) };
    expect(await resolveContent(store, "questA", "Unchanged.", [], vi.fn()))
      .toEqual({ text: "Unchanged." });
    expect(store.getMany).not.toHaveBeenCalled();
  });
});
