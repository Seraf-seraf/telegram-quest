export interface WebhookConfig {
  botToken: string;
  webhookSecret: string;
}

const webhookSecretPattern = /^[A-Za-z0-9_-]{1,256}$/;

function requiredValue(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be set without surrounding whitespace.`);
  }

  return value;
}

export function loadWebhookConfig(env: NodeJS.ProcessEnv): WebhookConfig {
  const botToken = requiredValue("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN);
  const webhookSecret = requiredValue(
    "TELEGRAM_WEBHOOK_SECRET",
    env.TELEGRAM_WEBHOOK_SECRET,
  );

  if (!webhookSecretPattern.test(webhookSecret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must contain 1 to 256 letters, digits, underscores, or hyphens.",
    );
  }

  return { botToken, webhookSecret };
}
