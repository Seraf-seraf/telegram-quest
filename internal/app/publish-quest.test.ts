import { describe, expect, it, vi } from "vitest";
import {
  applyPublicationPlan,
  preparePublication,
  PublicationInputError,
  type QuestPublicationPort,
} from "./publish-quest.js";

const compiledStory = JSON.stringify({ inkVersion: 21, root: [], listDefs: {} });
const questManifest = {
  id: "two-doors",
  title: "Две двери",
  description: "Короткая история",
  genre: "Мистика",
  available: true,
};

function createPublisher(): QuestPublicationPort {
  return {
    publishQuest: vi.fn(async () => {}),
    updateQuestMetadata: vi.fn(async () => {}),
    publishMenu: vi.fn(async () => {}),
  };
}

describe("preparePublication", () => {
  it("validates a full manifest and retains only listed metadata changes", () => {
    expect(preparePublication({
      mode: "full",
      manifest: {
        ...questManifest,
        metadata: {
          cover: { kind: "image", value: "https://assets.example/cover.jpg" },
          note: { kind: "text", value: "A faint note." },
        },
      },
      storyJson: compiledStory,
    })).toEqual({
      mode: "full",
      quest: {
        id: "two-doors",
        title: "Две двери",
        description: "Короткая история",
        genre: "Мистика",
        available: true,
      },
      storyJson: compiledStory,
      metadata: [
        {
          name: "cover",
          value: { kind: "image", value: "https://assets.example/cover.jpg" },
        },
        { name: "note", value: { kind: "text", value: "A faint note." } },
      ],
    });
  });

  it("prepares metadata-only updates without any story input", () => {
    expect(preparePublication({
      mode: "metadata-only",
      manifest: {
        ...questManifest,
        metadata: { cover: null },
      },
    })).toEqual({
      mode: "metadata-only",
      quest: {
        id: "two-doors",
        title: "Две двери",
        description: "Короткая история",
        genre: "Мистика",
        available: true,
      },
      metadata: [{ name: "cover", value: null }],
    });

    expect(preparePublication({ mode: "metadata-only", manifest: questManifest }))
      .toEqual({
        mode: "metadata-only",
        quest: {
          id: "two-doors",
          title: "Две двери",
          description: "Короткая история",
          genre: "Мистика",
          available: true,
        },
      });
  });

  it("prepares only global menu metadata", () => {
    expect(preparePublication({
      mode: "menu",
      manifest: {
        metadata: {
          "menu.main.banner": {
            kind: "image",
            value: "https://assets.example/menu.jpg",
          },
        },
      },
    })).toEqual({
      mode: "menu",
      metadata: [{
        name: "menu.main.banner",
        value: { kind: "image", value: "https://assets.example/menu.jpg" },
      }],
    });
  });

  it("rejects invalid IDs, names, kinds, image URLs, manifests, and compiled JSON", () => {
    const invalidCases: Array<() => unknown> = [
      () => preparePublication({
        mode: "metadata-only",
        manifest: { ...questManifest, id: "Bad ID" },
      }),
      () => preparePublication({
        mode: "menu",
        manifest: { metadata: { "bad name": { kind: "text", value: "x" } } },
      }),
      () => preparePublication({
        mode: "menu",
        manifest: { metadata: { image: { kind: "video", value: "x" } } },
      }),
      () => preparePublication({
        mode: "menu",
        manifest: { metadata: { image: { kind: "image", value: "http://assets.example/x" } } },
      }),
      () => preparePublication({
        mode: "menu",
        manifest: { metadata: { image: { kind: "image", value: "https://user:pass@assets.example/x" } } },
      }),
      () => preparePublication({
        mode: "full",
        manifest: questManifest,
        storyJson: "not json",
      }),
      () => preparePublication({
        mode: "full",
        manifest: { ...questManifest, extra: true },
        storyJson: compiledStory,
      }),
    ];

    for (const invalidCase of invalidCases) {
      expect(invalidCase).toThrow(PublicationInputError);
    }
  });

  it("routes validated plans to exactly one publication operation", async () => {
    const publisher = createPublisher();
    const fullPlan = preparePublication({
      mode: "full",
      manifest: questManifest,
      storyJson: compiledStory,
    });
    const metadataPlan = preparePublication({
      mode: "metadata-only",
      manifest: { ...questManifest, metadata: { note: null } },
    });
    const menuPlan = preparePublication({ mode: "menu", manifest: { metadata: {} } });

    await applyPublicationPlan(publisher, fullPlan);
    await applyPublicationPlan(publisher, metadataPlan);
    await applyPublicationPlan(publisher, menuPlan);

    expect(publisher.publishQuest).toHaveBeenCalledOnce();
    expect(publisher.updateQuestMetadata).toHaveBeenCalledOnce();
    expect(publisher.publishMenu).toHaveBeenCalledOnce();
    expect(publisher.publishQuest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "two-doors" }),
      compiledStory,
      undefined,
    );
    expect(publisher.updateQuestMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: "two-doors" }),
      [{ name: "note", value: null }],
    );
  });
});
