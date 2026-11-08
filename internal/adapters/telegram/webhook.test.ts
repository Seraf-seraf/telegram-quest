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
    bot.on("message:text", (context) => {
      receivedText = context.message.text;
    });

    const handleWebhook = createTelegramWebhookHandler(bot, secretToken);
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
    expect(receivedText).toBe("hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
