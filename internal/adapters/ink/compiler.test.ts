import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileInkStory } from "./compiler.js";

const temporaryDirectories = new Set<string>();

async function createBookDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-quest-ink-"));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
  temporaryDirectories.clear();
});

describe("compileInkStory", () => {
  it("compiles the existing Ink fixture with the installed inkjs compiler", async () => {
    const directory = await createBookDirectory();
    const fixture = await readFile(new URL("./fixtures/demo.ink", import.meta.url), "utf8");
    await writeFile(join(directory, "story.ink"), fixture, "utf8");

    const compiled = JSON.parse(await compileInkStory(directory)) as Record<string, unknown>;
    expect(compiled).toEqual(expect.objectContaining({
      inkVersion: expect.any(Number),
      root: expect.any(Array),
      listDefs: expect.any(Object),
    }));
  });

  it("resolves nested INCLUDE files from the including file inside the book folder", async () => {
    const directory = await createBookDirectory();
    await mkdir(join(directory, "chapters"), { recursive: true });
    await writeFile(join(directory, "story.ink"), [
      "INCLUDE chapters/intro.ink",
      "-> start",
    ].join("\n"), "utf8");
    await writeFile(join(directory, "chapters/intro.ink"), [
      "INCLUDE opening.ink",
      "=== start",
      "A decision follows.",
      "+ [Continue]",
      "    -> END",
    ].join("\n"), "utf8");
    await writeFile(join(directory, "chapters/opening.ink"), "// included chapter\n", "utf8");

    const compiled = JSON.parse(await compileInkStory(directory)) as Record<string, unknown>;
    expect(compiled.inkVersion).toEqual(expect.any(Number));
    expect(Array.isArray(compiled.root)).toBe(true);
  });

  it("rejects INCLUDE paths that leave the book folder", async () => {
    const parent = await createBookDirectory();
    const directory = join(parent, "book");
    await mkdir(directory);
    await writeFile(join(parent, "outside.ink"), "=== outside\nSecret.\n", "utf8");
    await writeFile(join(directory, "story.ink"), "INCLUDE ../outside.ink\n-> END\n", "utf8");

    await expect(compileInkStory(directory)).rejects.toThrow(
      "Ink files must stay inside the book folder.",
    );
  });

  it("rejects a story.ink symlink that points outside the book folder", async () => {
    const parent = await createBookDirectory();
    const directory = join(parent, "book");
    await mkdir(directory);
    await writeFile(join(parent, "outside.ink"), "-> END\n", "utf8");
    await symlink(join(parent, "outside.ink"), join(directory, "story.ink"));

    await expect(compileInkStory(directory)).rejects.toThrow(
      "Ink files must stay inside the book folder.",
    );
  });

  it("rejects an INCLUDE symlink that points outside the book folder", async () => {
    const parent = await createBookDirectory();
    const directory = join(parent, "book");
    await mkdir(directory);
    await writeFile(join(parent, "outside.ink"), "=== outside\nSecret.\n", "utf8");
    await writeFile(join(directory, "story.ink"), "INCLUDE outside.ink\n-> END\n", "utf8");
    await symlink(join(parent, "outside.ink"), join(directory, "outside.ink"));

    await expect(compileInkStory(directory)).rejects.toThrow("Ink compilation failed:");
  });
});
