import { InkStoryRuntime } from "./adapters/ink/runtime.js";
import { createTursoDatabase, type TursoDatabase } from "./adapters/turso/client.js";
import { ensureSchema } from "./adapters/turso/migrate.js";
import { loadStorageConfig } from "./config/env.js";
import type { StoryRuntime } from "./app/story.js";

export interface ReadyApp {
  database: TursoDatabase;
  storyRuntime: StoryRuntime;
}

export type BootstrapPhase = "configuration" | "connection" | "schema";

export interface BootstrapFailureEvent {
  event: "telegram_quest.bootstrap_failed";
  phase: BootstrapPhase;
  code: "APP_INITIALIZATION_FAILED";
}

export interface BootstrapDependencies {
  createDatabase: typeof createTursoDatabase;
  ensureSchema: typeof ensureSchema;
  logFailure: (event: BootstrapFailureEvent) => void;
}

const defaultDependencies: BootstrapDependencies = {
  createDatabase: createTursoDatabase,
  ensureSchema,
  logFailure: (event) => {
    console.error(JSON.stringify(event));
  },
};

export async function initializeApp(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<ReadyApp> {
  let phase: BootstrapPhase = "configuration";
  let database: TursoDatabase | undefined;

  try {
    const storageConfig = loadStorageConfig(env);
    phase = "connection";
    database = dependencies.createDatabase(storageConfig);
    phase = "schema";
    await dependencies.ensureSchema(database);

    return { database, storyRuntime: new InkStoryRuntime() };
  } catch {
    database?.close();
    dependencies.logFailure({
      event: "telegram_quest.bootstrap_failed",
      phase,
      code: "APP_INITIALIZATION_FAILED",
    });
    throw new Error("Application initialization failed.");
  }
}

export function createReadyAppGetter<T>(factory: () => Promise<T>): () => Promise<T> {
  let readyApp: Promise<T> | undefined;

  return (): Promise<T> => {
    if (readyApp !== undefined) {
      return readyApp;
    }

    const current = Promise.resolve().then(factory);
    readyApp = current;
    void current.catch(() => {
      if (readyApp === current) {
        readyApp = undefined;
      }
    });
    return current;
  };
}

export const getReadyApp = createReadyAppGetter(initializeApp);
