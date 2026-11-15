import { loadWebhookConfig } from "../internal/config/env.js";
import { createTelegramBot } from "../internal/adapters/telegram/bot.js";
import { registerPrivateQuestHandlers } from "../internal/adapters/telegram/private-quest.js";
import { createTelegramWebhookHandler } from "../internal/adapters/telegram/webhook.js";
import { getReadyApp } from "../internal/bootstrap.js";

const config = loadWebhookConfig(process.env);
const bot = createTelegramBot(config.botToken);
registerPrivateQuestHandlers(bot, getReadyApp);
const handleWebhook = createTelegramWebhookHandler(
  bot,
  config.webhookSecret,
  async () => {
    await getReadyApp();
  },
);

export function POST(request: Request): Promise<Response> {
  return handleWebhook(request);
}
