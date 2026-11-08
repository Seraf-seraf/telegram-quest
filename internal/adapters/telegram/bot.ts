import { Bot } from "grammy";

export function createTelegramBot(botToken: string): Bot {
  return new Bot(botToken);
}
