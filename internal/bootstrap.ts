import { InkStoryRuntime } from "./adapters/ink/runtime.js";
import { createTursoQuestCatalog } from "./adapters/turso/catalog.js";
import { createTursoDatabase, type TursoDatabase } from "./adapters/turso/client.js";
import { ensureSchema } from "./adapters/turso/migrate.js";
import { ensureDemoCatalog } from "./adapters/turso/seed.js";
import { createTursoStorySource } from "./adapters/turso/story-source.js";
import { createTursoSessionStore } from "./adapters/turso/store.js";
import { loadStorageConfig } from "./config/env.js";
import type { QuestCatalog } from "./app/quest-catalog.js";
import { SessionService } from "./app/sessions.js";
import type { StoryRuntime } from "./app/story.js";
import type { StorySource } from "./app/story-source.js";

export interface ReadyApp {
  database: TursoDatabase;
  storyRuntime: StoryRuntime;
  sessions: SessionService;
  catalog: QuestCatalog;
}

export type BootstrapPhase = "configuration" | "connection" | "schema" | "catalog";

export interface BootstrapFailureEvent {
  event: "telegram_quest.bootstrap_failed";
  phase: BootstrapPhase;
  code: "APP_INITIALIZATION_FAILED";
}

export interface BootstrapDependencies {
  createDatabase: typeof createTursoDatabase;
  ensureSchema: typeof ensureSchema;
  logFailure: (event: BootstrapFailureEvent) => void;
  storySource?: StorySource;
  ensureDemoCatalog?: typeof ensureDemoCatalog;
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

    const storySource = dependencies.storySource ?? createTursoStorySource(database);
    if (dependencies.storySource === undefined || dependencies.ensureDemoCatalog !== undefined) {
      phase = "catalog";
      await (dependencies.ensureDemoCatalog ?? ensureDemoCatalog)(database);
    }

    const storyRuntime = new InkStoryRuntime();
    return {
      database,
      storyRuntime,
      sessions: new SessionService({
        store: createTursoSessionStore(database),
        storyRuntime,
        storySource,
      }),
      catalog: createTursoQuestCatalog(database),
    };
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
