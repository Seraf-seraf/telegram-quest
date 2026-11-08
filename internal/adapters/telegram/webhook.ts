import { timingSafeEqual } from "node:crypto";
import { webhookCallback, type Bot } from "grammy";

function hasValidSecretToken(request: Request, expectedToken: string): boolean {
  const suppliedToken = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token",
  );

  if (suppliedToken === null) {
    return false;
  }

  const suppliedBytes = Buffer.from(suppliedToken, "utf8");
  const expectedBytes = Buffer.from(expectedToken, "utf8");

  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

export function createTelegramWebhookHandler(
  bot: Bot,
  secretToken: string,
): (request: Request) => Promise<Response> {
  const handleUpdate = webhookCallback(bot, "std/http", { secretToken });

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    // grammY initializes the bot before checking secretToken. Reject first so
    // an invalid request cannot trigger its initial getMe API call.
    if (!hasValidSecretToken(request, secretToken)) {
      return new Response(null, { status: 401 });
    }

    return handleUpdate(request);
  };
}
