import { connect, type Config } from "@tursodatabase/serverless";
import type { StorageConfig } from "../../config/env.js";

export type SqlParameter =
  | ArrayBuffer
  | bigint
  | boolean
  | null
  | number
  | string
  | Uint8Array;

export type SqlRow = Record<string, unknown>;

export interface SqlExecutor {
  all(sql: string, ...args: SqlParameter[]): Promise<SqlRow[]>;
  exec(sql: string): Promise<void>;
  get(sql: string, ...args: SqlParameter[]): Promise<SqlRow | undefined>;
  run(sql: string, ...args: SqlParameter[]): Promise<void>;
}

export interface TursoDatabase {
  close(): void;
  read<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  write<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

interface TursoConnection extends SqlExecutor {
  readonly inTransaction: boolean;
  close(): Promise<void>;
  pragma(pragma: string): Promise<unknown>;
}

type ConnectionFactory = (config: Config) => TursoConnection;

function makeExecutor(connection: TursoConnection): SqlExecutor {
  return {
    all: (sql, ...args) => connection.all(sql, ...args),
    exec: async (sql) => {
      await connection.exec(sql);
    },
    get: (sql, ...args) => connection.get(sql, ...args),
    run: async (sql, ...args) => {
      await connection.run(sql, ...args);
    },
  };
}

async function enableAndVerifyForeignKeys(
  connection: TursoConnection,
): Promise<void> {
  await connection.pragma("foreign_keys = ON");
  const row = await connection.get("PRAGMA foreign_keys");

  if (Number(row?.foreign_keys) !== 1) {
    throw new Error("Turso connection did not enable foreign-key enforcement.");
  }
}

export function createTursoDatabase(
  config: StorageConfig,
  connectionFactory: ConnectionFactory = connect,
): TursoDatabase {
  let closed = false;

  async function execute<T>(
    operation: (executor: SqlExecutor) => Promise<T>,
    transaction: boolean,
  ): Promise<T> {
    if (closed) {
      throw new Error("Turso database is closed.");
    }

    const connection = connectionFactory({
      url: config.databaseUrl,
      authToken: config.authToken,
    });

    try {
      await enableAndVerifyForeignKeys(connection);

      if (transaction) {
        await connection.exec("BEGIN IMMEDIATE");

        if (!connection.inTransaction) {
          throw new Error("Turso did not start the requested write transaction.");
        }
      }

      const result = await operation(makeExecutor(connection));

      if (transaction) {
        await connection.exec("COMMIT");
      }

      return result;
    } catch (error) {
      if (transaction && connection.inTransaction) {
        try {
          await connection.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Turso operation failed and its transaction could not be rolled back.",
          );
        }
      }

      throw error;
    } finally {
      await connection.close();
    }
  }

  return {
    close(): void {
      closed = true;
    },
    read: <T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> =>
      execute(operation, false),
    write: <T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> =>
      execute(operation, true),
  };
}
