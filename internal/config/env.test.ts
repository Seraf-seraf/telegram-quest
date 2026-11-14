import { describe, expect, it } from "vitest";
import { loadStorageConfig, loadWebhookConfig } from "./env.js";

describe("loadWebhookConfig", () => {
  it("returns required Telegram webhook settings", () => {
    expect(
      loadWebhookConfig({
        TELEGRAM_BOT_TOKEN: "123456:bot-token",
        TELEGRAM_WEBHOOK_SECRET: "valid_secret-123",
      }),
    ).toEqual({
      botToken: "123456:bot-token",
      webhookSecret: "valid_secret-123",
    });
  });

  it.each([
    [{ TELEGRAM_WEBHOOK_SECRET: "valid_secret-123" }, "TELEGRAM_BOT_TOKEN"],
    [
      {
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_WEBHOOK_SECRET: "valid_secret-123",
      },
      "TELEGRAM_BOT_TOKEN",
    ],
    [{ TELEGRAM_BOT_TOKEN: "123456:bot-token" }, "TELEGRAM_WEBHOOK_SECRET"],
    [
      {
        TELEGRAM_BOT_TOKEN: "123456:bot-token",
        TELEGRAM_WEBHOOK_SECRET: "invalid/secret",
      },
      "TELEGRAM_WEBHOOK_SECRET",
    ],
    [
      {
        TELEGRAM_BOT_TOKEN: "123456:bot-token",
        TELEGRAM_WEBHOOK_SECRET: "s".repeat(257),
      },
      "TELEGRAM_WEBHOOK_SECRET",
    ],
  ] as const)("rejects invalid required values without echoing them", (env, name) => {
    try {
      loadWebhookConfig(env);
      throw new Error("Expected invalid configuration to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(name);

      for (const value of Object.values(env)) {
        if (value.length > 0) {
          expect(message).not.toContain(value);
        }
      }
    }
  });

  it("rejects a secret containing surrounding whitespace", () => {
    expect(() =>
      loadWebhookConfig({
        TELEGRAM_BOT_TOKEN: "123456:bot-token",
        TELEGRAM_WEBHOOK_SECRET: " secret ",
      }),
    ).toThrow("TELEGRAM_WEBHOOK_SECRET");
  });
});

describe("loadStorageConfig", () => {
  it("returns required Turso settings", () => {
    expect(
      loadStorageConfig({
        TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
        TURSO_AUTH_TOKEN: "turso-auth-token",
      }),
    ).toEqual({
      databaseUrl: "libsql://quest-example.turso.io",
      authToken: "turso-auth-token",
    });
  });

  it.each([
    [{ TURSO_AUTH_TOKEN: "turso-auth-token" }, "TURSO_DATABASE_URL"],
    [
      {
        TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
      },
      "TURSO_AUTH_TOKEN",
    ],
    [
      {
        TURSO_DATABASE_URL: "not-a-url",
        TURSO_AUTH_TOKEN: "turso-auth-token",
      },
      "TURSO_DATABASE_URL",
    ],
    [
      {
        TURSO_DATABASE_URL: "file:quest.db",
        TURSO_AUTH_TOKEN: "turso-auth-token",
      },
      "TURSO_DATABASE_URL",
    ],
    [
      {
        TURSO_DATABASE_URL: "libsql://quest-example.turso.io",
        TURSO_AUTH_TOKEN: " token-with-space ",
      },
      "TURSO_AUTH_TOKEN",
    ],
  ] as const)("rejects invalid storage values without echoing them", (env, name) => {
    try {
      loadStorageConfig(env);
      throw new Error("Expected invalid storage configuration to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(name);

      for (const value of Object.values(env)) {
        if (value.length > 0) {
          expect(message).not.toContain(value);
        }
      }
    }
  });
});
