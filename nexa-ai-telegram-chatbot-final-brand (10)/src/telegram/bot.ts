import { Telegraf } from "telegraf";
import type { Update } from "telegraf/types";
import { getEnv, isTelegramConfigured } from "@/config/env";
import {
  registerBotCommands,
  syncTelegramBotProfile,
  type ProfileSyncResult,
} from "@/telegram/commands";
import { registerBotHandlers } from "@/telegram/handlers";
import { logger } from "@/utils/logger";

export interface TelegramBotRuntimeState {
  configured: boolean;
  mode: "polling" | "webhook" | "disabled";
  pollingActive: boolean;
  startedAt: string | null;
  lastError: string | null;
  profileSyncedAt: string | null;
}

interface BotSingletonHolder {
  bot: Telegraf | null;
  token: string;
  pollingActive: boolean;
  pollingStarting: boolean;
  startedAt: string | null;
  lastError: string | null;
  profileSyncedAt: string | null;
}

const globalForBot = globalThis as typeof globalThis & {
  __nexaTelegramBotHolder?: BotSingletonHolder;
};

function getHolder(): BotSingletonHolder {
  if (!globalForBot.__nexaTelegramBotHolder) {
    globalForBot.__nexaTelegramBotHolder = {
      bot: null,
      token: "",
      pollingActive: false,
      pollingStarting: false,
      startedAt: null,
      lastError: null,
      profileSyncedAt: null,
    };
  }
  return globalForBot.__nexaTelegramBotHolder;
}

export function createNexaBot(token: string): Telegraf {
  const bot = new Telegraf(token);
  registerBotCommands(bot);
  registerBotHandlers(bot);
  return bot;
}

export function getTelegramBot(): Telegraf {
  const env = getEnv();
  if (!isTelegramConfigured()) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const holder = getHolder();
  if (!holder.bot || holder.token !== env.TELEGRAM_BOT_TOKEN) {
    holder.bot = createNexaBot(env.TELEGRAM_BOT_TOKEN);
    holder.token = env.TELEGRAM_BOT_TOKEN;
  }

  return holder.bot;
}

export function getBotRuntimeState(): TelegramBotRuntimeState {
  const env = getEnv();
  const holder = getHolder();
  return {
    configured: isTelegramConfigured(),
    mode: env.TELEGRAM_MODE,
    pollingActive: holder.pollingActive,
    startedAt: holder.startedAt,
    lastError: holder.lastError,
    profileSyncedAt: holder.profileSyncedAt,
  };
}

/**
 * Starts Telegram long-polling cleanly (used in local dev or sandbox runtime).
 * Deletes any conflicting webhook first so Telegram never throws 409 errors.
 */
export async function startBotPolling(options?: {
  syncProfile?: boolean;
}): Promise<TelegramBotRuntimeState> {
  const holder = getHolder();
  if (!isTelegramConfigured()) {
    holder.lastError = "TELEGRAM_BOT_TOKEN is not configured";
    return getBotRuntimeState();
  }

  if (holder.pollingActive || holder.pollingStarting) {
    return getBotRuntimeState();
  }

  holder.pollingStarting = true;
  holder.lastError = null;

  try {
    const bot = getTelegramBot();

    // Remove existing webhook before entering long-polling mode
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });

    if (options?.syncProfile !== false) {
      await syncTelegramBotProfile(bot);
      holder.profileSyncedAt = new Date().toISOString();
    }

    // Launch polling asynchronously; Telegraf's launch() resolves only when stopped
    // so we attach error handling and confirm connectivity via getMe() first.
    const me = await bot.telegram.getMe();
    holder.pollingActive = true;
    holder.startedAt = new Date().toISOString();

    bot
      .launch({ dropPendingUpdates: false })
      .then(() => {
        holder.pollingActive = false;
      })
      .catch((err) => {
        holder.pollingActive = false;
        holder.lastError = err instanceof Error ? err.message : String(err);
        logger.error("Telegram long-polling terminated with error", { err });
      });

    logger.info("NEXA AI Telegram bot polling started", {
      botId: me.id,
      username: me.username,
    });
  } catch (err) {
    holder.pollingActive = false;
    holder.lastError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to start Telegram polling", { err });
  } finally {
    holder.pollingStarting = false;
  }

  return getBotRuntimeState();
}

export async function stopBotPolling(reason = "MANUAL_STOP"): Promise<TelegramBotRuntimeState> {
  const holder = getHolder();
  if (holder.bot && holder.pollingActive) {
    try {
      holder.bot.stop(reason);
    } catch (err) {
      logger.warn("Error while stopping Telegram polling", { err });
    }
  }
  holder.pollingActive = false;
  holder.startedAt = null;
  // Reset cached bot so it can be cleanly re-launched later
  holder.bot = null;
  holder.token = "";
  return getBotRuntimeState();
}

export async function handleWebhookUpdate(update: Update): Promise<void> {
  const bot = getTelegramBot();
  await bot.handleUpdate(update);
}

export async function syncBotProfileNow(): Promise<ProfileSyncResult> {
  const bot = getTelegramBot();
  const result = await syncTelegramBotProfile(bot);
  getHolder().profileSyncedAt = new Date().toISOString();
  return result;
}

export async function setProductionWebhook(
  webhookUrl: string,
  secretToken?: string
): Promise<{ ok: boolean; webhookUrl: string }> {
  const holder = getHolder();
  if (holder.pollingActive) {
    await stopBotPolling("SWITCH_TO_WEBHOOK");
  }

  const bot = getTelegramBot();
  const normalizedUrl = webhookUrl.trim().replace(/\/+$/, "");
  const fullWebhookEndpoint = normalizedUrl.endsWith("/api/telegram/webhook")
    ? normalizedUrl
    : `${normalizedUrl}/api/telegram/webhook`;

  await bot.telegram.setWebhook(fullWebhookEndpoint, {
    secret_token: secretToken || getEnv().WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "callback_query"],
  });

  logger.info("Configured Telegram production webhook", {
    webhookEndpoint: fullWebhookEndpoint,
  });

  return { ok: true, webhookUrl: fullWebhookEndpoint };
}

export async function deleteTelegramWebhook(): Promise<{ ok: boolean }> {
  const bot = getTelegramBot();
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  logger.info("Deleted Telegram webhook");
  return { ok: true };
}

export async function getTelegramBotLiveInfo(): Promise<{
  ok: boolean;
  configured: boolean;
  bot?: {
    id: number;
    username: string;
    firstName: string;
    canJoinGroups: boolean;
    supportsInlineQueries: boolean;
    deepLink: string;
  };
  webhook?: {
    url: string;
    hasCustomCertificate: boolean;
    pendingUpdateCount: number;
    lastErrorMessage?: string;
  };
  runtime: TelegramBotRuntimeState;
  error?: string;
}> {
  const runtime = getBotRuntimeState();
  if (!isTelegramConfigured()) {
    return {
      ok: false,
      configured: false,
      runtime,
      error: "TELEGRAM_BOT_TOKEN is not configured",
    };
  }

  try {
    const bot = getTelegramBot();
    const [me, webhookInfo] = await Promise.all([
      bot.telegram.getMe(),
      bot.telegram.getWebhookInfo(),
    ]);

    return {
      ok: true,
      configured: true,
      bot: {
        id: me.id,
        username: me.username ?? "",
        firstName: me.first_name,
        canJoinGroups: Boolean(me.can_join_groups),
        supportsInlineQueries: Boolean(me.supports_inline_queries),
        deepLink: me.username ? `https://t.me/${me.username}` : "",
      },
      webhook: {
        url: webhookInfo.url || "",
        hasCustomCertificate: webhookInfo.has_custom_certificate,
        pendingUpdateCount: webhookInfo.pending_update_count,
        lastErrorMessage: webhookInfo.last_error_message,
      },
      runtime,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      runtime,
      error: err instanceof Error ? err.message : "Unable to reach Telegram Bot API",
    };
  }
}
