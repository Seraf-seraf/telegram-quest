import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createTelegramWebhookHandler } from "./webhook.js";

const botToken = "123456:fake-bot-token";
const secretToken = "correct-secret_123";

function createRequest(secret: string, body: string): Request {
  return new Request("https://telegram-quest.example/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body,
  });
}

function createTelegramApiFetchMock(): typeof fetch {
  return vi.fn<typeof fetch>(async () => {
    throw new Error("Unexpected Telegram API call.");
  });
}

describe("createTelegramWebhookHandler", () => {
  it("rejects non-POST requests before calling the Telegram API", async () => {
    const fetchMock = createTelegramApiFetchMock();

    const bot = new Bot(botToken, { client: { fetch: fetchMock } });
    const handleWebhook = createTelegramWebhookHandler(bot, secretToken);
    const response = await handleWebhook(
      new Request("https://telegram-quest.example/api/webhook", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid secret before calling the Telegram API", async () => {
    const fetchMock = createTelegramApiFetchMock();

    const bot = new Bot(botToken, { client: { fetch: fetchMock } });
    const handleWebhook = createTelegramWebhookHandler(bot, secretToken);
    const response = await handleWebhook(
      createRequest(
        "wrong-secret",
        JSON.stringify({ update_id: 1 }),
      ),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not initialize storage until POST and secret checks pass", async () => {
    const fetchMock = createTelegramApiFetchMock();
    const ensureReady = vi.fn(async () => undefined);
    const bot = new Bot(botToken, { client: { fetch: fetchMock } });
    const handleWebhook = createTelegramWebhookHandler(
      bot,
      secretToken,
      ensureReady,
    );

    const methodResponse = await handleWebhook(
      new Request("https://telegram-quest.example/api/webhook", {
        method: "GET",
      }),
    );
    const secretResponse = await handleWebhook(
      createRequest("wrong-secret", JSON.stringify({ update_id: 1 })),
    );

    expect(methodResponse.status).toBe(405);
    expect(secretResponse.status).toBe(401);
    expect(ensureReady).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a detail-free 503 if storage is not ready", async () => {
    const fetchMock = createTelegramApiFetchMock();
    const ensureReady = vi.fn(async () => {
      throw new Error("private database URL and token");
    });
    const bot = new Bot(botToken, { client: { fetch: fetchMock } });
    const handleWebhook = createTelegramWebhookHandler(
      bot,
      secretToken,
      ensureReady,
    );
    const response = await handleWebhook(
      createRequest(secretToken, JSON.stringify({ update_id: 1 })),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(ensureReady).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a valid update to grammY without calling the real Telegram API", async () => {
    const fetchMock = createTelegramApiFetchMock();

    const bot = new Bot(botToken, {
      client: { fetch: fetchMock },
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "Test bot",
        username: "telegram_quest_test_bot",
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    });
    let receivedText: string | undefined;
    const calls: string[] = [];
    bot.on("message:text", (context) => {
      receivedText = context.message.text;
    });

    const handleWebhook = createTelegramWebhookHandler(
      bot,
      secretToken,
      async () => {
        calls.push("ready");
      },
    );
    const response = await handleWebhook(
      createRequest(
        secretToken,
        JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private", first_name: "Test user" },
            from: { id: 1, is_bot: false, first_name: "Test user" },
            text: "hello",
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["ready"]);
    expect(receivedText).toBe("hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
