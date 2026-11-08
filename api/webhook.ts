import { loadWebhookConfig } from "../internal/config/env.js";
import { createTelegramBot } from "../internal/adapters/telegram/bot.js";
import { createTelegramWebhookHandler } from "../internal/adapters/telegram/webhook.js";

const config = loadWebhookConfig(process.env);
const bot = createTelegramBot(config.botToken);
const handleWebhook = createTelegramWebhookHandler(bot, config.webhookSecret);

export function POST(request: Request): Promise<Response> {
  return handleWebhook(request);
}
