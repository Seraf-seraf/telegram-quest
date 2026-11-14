export interface WebhookConfig {
  botToken: string;
  webhookSecret: string;
}

export interface StorageConfig {
  databaseUrl: string;
  authToken: string;
}

const webhookSecretPattern = /^[A-Za-z0-9_-]{1,256}$/;
const storageUrlProtocols = new Set(["https:", "libsql:", "turso:"]);

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

export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const databaseUrl = requiredValue("TURSO_DATABASE_URL", env.TURSO_DATABASE_URL);
  const authToken = requiredValue("TURSO_AUTH_TOKEN", env.TURSO_AUTH_TOKEN);
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("TURSO_DATABASE_URL must be a valid Turso URL.");
  }

  if (
    !storageUrlProtocols.has(parsedUrl.protocol) ||
    parsedUrl.hostname.length === 0 ||
    parsedUrl.username.length > 0 ||
    parsedUrl.password.length > 0 ||
    parsedUrl.hash.length > 0
  ) {
    throw new Error("TURSO_DATABASE_URL must be a valid Turso URL.");
  }

  return { databaseUrl, authToken };
}
