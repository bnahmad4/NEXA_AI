import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required").optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_FALLBACK_MODELS: z
    .string()
    .optional()
    .default("gemini-3.1-flash-lite,gemini-3.6-flash"),
  TELEGRAM_MODE: z.enum(["polling", "webhook", "disabled"]).default("polling"),
  WEBHOOK_URL: z.string().optional().default(""),
  WEBHOOK_SECRET: z.string().optional().default(""),
  ADMIN_API_KEY: z.string().optional().default(""),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(500).default(15),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(100).default(20),
  MAX_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(200000).default(24000),
});

export type AppEnv = z.infer<typeof envSchema> & {
  fallbackModels: string[];
};

let cachedEnv: AppEnv | null = null;

export function getEnv(forceReload = false): AppEnv {
  if (cachedEnv && !forceReload) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const fallbackModels = parsed.data.GEMINI_FALLBACK_MODELS.split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && m !== parsed.data.GEMINI_MODEL);

  cachedEnv = {
    ...parsed.data,
    fallbackModels,
  };

  return cachedEnv;
}

export function isTelegramConfigured(): boolean {
  const token = getEnv().TELEGRAM_BOT_TOKEN.trim();
  return token.length > 10 && token.includes(":");
}

export function isGeminiConfigured(): boolean {
  const key = getEnv().GEMINI_API_KEY.trim();
  return key.length > 10;
}

export function getSecretValuesForRedaction(): string[] {
  const env = getEnv();
  return [
    env.TELEGRAM_BOT_TOKEN,
    env.GEMINI_API_KEY,
    env.WEBHOOK_SECRET,
    env.ADMIN_API_KEY,
    env.DATABASE_URL ?? "",
  ].filter((v) => v.length >= 8);
}
