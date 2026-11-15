import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Compiler, CompilerOptions } from "inkjs/compiler/Compiler";
import type { IFileHandler } from "inkjs/compiler/IFileHandler";

function assertBookPath(bookRoot: string, targetPath: string): void {
  const pathFromRoot = relative(bookRoot, targetPath);
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Ink files must stay inside the book folder.");
  }
}

function createBookFileHandler(bookRoot: string): IFileHandler {
  const resolveInkPath = (filename: string, sourceFilename?: string | null): string => {
    const sourcePath = sourceFilename == null
      ? bookRoot
      : resolve(bookRoot, sourceFilename);
    const baseDirectory = sourceFilename == null ? bookRoot : dirname(sourcePath);
    const resolvedPath = resolve(baseDirectory, filename);
    assertBookPath(bookRoot, resolvedPath);
    return resolvedPath;
  };

  return {
    ResolveInkFilename: resolveInkPath,
    LoadInkFileContents(filename: string): string {
      const resolvedPath = resolve(bookRoot, filename);
      assertBookPath(bookRoot, resolvedPath);
      const realPath = realpathSync(resolvedPath);
      assertBookPath(bookRoot, realPath);
      return readFileSync(realPath, "utf8");
    },
  };
}

export async function compileInkStory(bookDirectory: string): Promise<string> {
  const bookRoot = realpathSync(bookDirectory);
  if (!statSync(bookRoot).isDirectory()) {
    throw new Error("Book path must be a directory.");
  }

  const storyPath = resolve(bookRoot, "story.ink");
  assertBookPath(bookRoot, storyPath);
  const realStoryPath = realpathSync(storyPath);
  assertBookPath(bookRoot, realStoryPath);
  if (!statSync(realStoryPath).isFile()) {
    throw new Error("Book story.ink must be a file.");
  }

  const fileHandler = createBookFileHandler(bookRoot);
  const compiler = new Compiler(
    readFileSync(realStoryPath, "utf8"),
    new CompilerOptions(realStoryPath, [], false, null, fileHandler),
  );

  try {
    const story = compiler.Compile();
    const storyJson = story.ToJson();
    if (typeof storyJson !== "string") {
      throw new Error("Ink compiler did not produce JSON.");
    }
    return storyJson;
  } catch (error) {
    if (error instanceof Error && error.message === "Ink files must stay inside the book folder.") {
      throw error;
    }
    const compilerErrors = compiler.errors;
    if (compilerErrors.length > 0) {
      throw new Error(`Ink compilation failed: ${compilerErrors.join("\n")}`);
    }
    throw new Error("Ink compilation failed.", { cause: error });
  }
}
