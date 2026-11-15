import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyPublicationPlan,
  preparePublication,
  PublicationInputError,
  type PublicationPlan,
  type QuestPublicationPort,
} from "../internal/app/publish-quest.js";
import { compileInkStory } from "../internal/adapters/ink/compiler.js";
import { createTursoDatabase, type TursoDatabase } from "../internal/adapters/turso/client.js";
import { createTursoQuestPublisher } from "../internal/adapters/turso/publisher.js";
import { loadStorageConfig } from "../internal/config/env.js";

type CliMode = "full" | "metadata-only" | "menu";

interface CliArguments {
  mode: CliMode;
  inputPath: string;
  dryRun: boolean;
}

interface CliDependencies {
  readFile: (filePath: string, encoding: "utf8") => Promise<string>;
  compileStory: (bookDirectory: string) => Promise<string>;
  loadStorageConfig: typeof loadStorageConfig;
  createDatabase: typeof createTursoDatabase;
  assertSchemaReady: (database: TursoDatabase) => Promise<void>;
  createPublisher: (database: TursoDatabase) => QuestPublicationPort;
  writeOutput: (message: string) => void;
  writeError: (message: string) => void;
}

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export async function assertPublicationSchemaReady(database: TursoDatabase): Promise<void> {
  try {
    const version = await database.read(async (executor) => {
      const marker = await executor.get(
        "SELECT version FROM quest_schema_version WHERE id = 1",
      );
      const storedVersion = Number(marker?.version);
      if (!Number.isSafeInteger(storedVersion) || storedVersion !== 4) {
        throw new Error("schema version mismatch");
      }
      await executor.get(
        "SELECT id, title, description, genre, available, story_json FROM quest LIMIT 0",
      );
      await executor.get(
        "SELECT quest_id, name, kind, value FROM content_metadata LIMIT 0",
      );
      return storedVersion;
    });
    if (version !== 4) {
      throw new Error("schema version mismatch");
    }
  } catch {
    throw new Error("Turso schema version 4 is required; start the application to apply migrations.");
  }
}

export function parseCliArguments(args: readonly string[]): CliArguments {
  if (args[0] === "--menu") {
    if (args.length < 2 || args.length > 3 || args[1]?.startsWith("--")) {
      throw new CliUsageError(
        "Usage: npm run quest:publish -- --menu <file.json> [--dry-run]",
      );
    }
    if (args.length === 3 && args[2] !== "--dry-run") {
      throw new CliUsageError(
        "Usage: npm run quest:publish -- --menu <file.json> [--dry-run]",
      );
    }
    return { mode: "menu", inputPath: args[1]!, dryRun: args[2] === "--dry-run" };
  }

  const inputPath = args[0];
  if (inputPath === undefined || inputPath.startsWith("--")) {
    throw new CliUsageError(
      "Usage: npm run quest:publish -- <folder> [--metadata-only] [--dry-run]",
    );
  }

  let mode: CliMode = "full";
  let metadataOnlySeen = false;
  let dryRun = false;
  for (const argument of args.slice(1)) {
    if (argument === "--metadata-only" && !metadataOnlySeen) {
      metadataOnlySeen = true;
      mode = "metadata-only";
    } else if (argument === "--dry-run" && !dryRun) {
      dryRun = true;
    } else {
      throw new CliUsageError(
        "Usage: npm run quest:publish -- <folder> [--metadata-only] [--dry-run]",
      );
    }
  }

  return { mode, inputPath, dryRun };
}

function parseJsonFile(contents: string, filename: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new PublicationInputError(`${filename} must contain valid JSON.`);
  }
}

async function readPublicationPlan(
  args: CliArguments,
  dependencies: Pick<CliDependencies, "readFile" | "compileStory">,
): Promise<PublicationPlan> {
  const inputPath = resolve(args.inputPath);
  if (args.mode === "menu") {
    const contents = await dependencies.readFile(inputPath, "utf8");
    return preparePublication({
      mode: "menu",
      manifest: parseJsonFile(contents, basename(inputPath)),
    });
  }

  const manifestPath = join(inputPath, "quest.json");
  const manifestContents = await dependencies.readFile(manifestPath, "utf8");
  const manifest = parseJsonFile(manifestContents, "quest.json");
  if (args.mode === "metadata-only") {
    return preparePublication({ mode: "metadata-only", manifest });
  }

  const storyJson = await dependencies.compileStory(inputPath);
  return preparePublication({ mode: "full", manifest, storyJson });
}

const defaultDependencies: CliDependencies = {
  readFile: async (filePath, encoding) => readFile(filePath, encoding),
  compileStory: compileInkStory,
  loadStorageConfig: (env) => loadStorageConfig(env),
  createDatabase: (config) => createTursoDatabase(config),
  assertSchemaReady: assertPublicationSchemaReady,
  createPublisher: createTursoQuestPublisher,
  writeOutput: (message) => process.stdout.write(`${message}\n`),
  writeError: (message) => process.stderr.write(`${message}\n`),
};

export async function runPublishQuestCli(
  args: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cliArguments = parseCliArguments(args);
  const plan = await readPublicationPlan(cliArguments, dependencies);

  if (cliArguments.dryRun) {
    dependencies.writeOutput("Dry run passed. No database connection was made.");
    return;
  }

  let database: TursoDatabase | undefined;
  try {
    database = dependencies.createDatabase(dependencies.loadStorageConfig(env));
    await dependencies.assertSchemaReady(database);
    await applyPublicationPlan(dependencies.createPublisher(database), plan);
  } catch {
    throw new Error("Publication failed. Check the database connection and schema.");
  } finally {
    database?.close();
  }

  dependencies.writeOutput(`Publication complete (${plan.mode}).`);
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = defaultDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    await runPublishQuestCli(args, dependencies, env);
    return 0;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Publication failed.";
    dependencies.writeError(message);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
