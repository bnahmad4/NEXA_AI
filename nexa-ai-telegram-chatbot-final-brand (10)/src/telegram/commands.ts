import type { Context, Telegraf } from "telegraf";
import {
  ABOUT_MESSAGE_HTML,
  BOT_COMMANDS_SPEC,
  HELP_MESSAGE_HTML,
  NEXA_BRAND,
} from "@/ai/prompts";
import { checkGeminiHealth } from "@/ai/gemini";
import { checkDatabaseHealth } from "@/db";
import {
  buildInfoKeyboard,
  buildWelcomeKeyboard,
} from "@/telegram/keyboards";
import { upsertTelegramUser } from "@/services/user.service";
import {
  getOrCreateActiveConversation,
  resetUserConversation,
} from "@/services/conversation.service";
import { getSafeUserErrorMessage } from "@/middleware/error-handler";
import { logger } from "@/utils/logger";

export async function handleStartCommand(ctx: Context): Promise<void> {
  try {
    if (ctx.from) {
      const user = await upsertTelegramUser({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        languageCode: ctx.from.language_code,
        isBot: ctx.from.is_bot,
      });
      await getOrCreateActiveConversation(user.id);
    }

    await ctx.reply(NEXA_BRAND.welcomeMessage, {
      ...buildWelcomeKeyboard(),
    });
  } catch (err) {
    logger.error("Failed to handle /start command", { err });
    await ctx.reply(getSafeUserErrorMessage(err));
  }
}

export async function handleHelpCommand(ctx: Context): Promise<void> {
  try {
    await ctx.reply(HELP_MESSAGE_HTML, {
      parse_mode: "HTML",
      ...buildInfoKeyboard(),
    });
  } catch (err) {
    logger.error("Failed to handle /help command", { err });
    await ctx.reply(getSafeUserErrorMessage(err));
  }
}

export async function handleAboutCommand(ctx: Context): Promise<void> {
  try {
    await ctx.reply(ABOUT_MESSAGE_HTML, {
      parse_mode: "HTML",
      ...buildInfoKeyboard(),
    });
  } catch (err) {
    logger.error("Failed to handle /about command", { err });
    await ctx.reply(getSafeUserErrorMessage(err));
  }
}

export async function handleResetCommand(ctx: Context): Promise<void> {
  try {
    if (!ctx.from) {
      await ctx.reply("Unable to identify your Telegram account for reset.");
      return;
    }

    const user = await upsertTelegramUser({
      telegramId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      languageCode: ctx.from.language_code,
      isBot: ctx.from.is_bot,
    });

    const { previousCount } = await resetUserConversation(user.id);

    const detail =
      previousCount > 0
        ? `Cleared ${previousCount} previous message${previousCount === 1 ? "" : "s"} from active context.`
        : "Your conversation context was already fresh.";

    await ctx.reply(
      `<b>Conversation Reset</b>\n\n${detail}\nWe're starting with a clean slate—what would you like to explore next?`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    logger.error("Failed to handle /reset command", { err });
    await ctx.reply(getSafeUserErrorMessage(err));
  }
}

export async function handleStatusCommand(ctx: Context): Promise<void> {
  try {
    await ctx.sendChatAction("typing").catch(() => undefined);

    const [dbHealth, geminiHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkGeminiHealth(),
    ]);

    const overallOk = dbHealth.ok && geminiHealth.ok;
    const statusHeader = overallOk
      ? "<b>NEXA AI System Status — Operational</b>"
      : "<b>NEXA AI System Status — Degraded</b>";

    const lines = [
      statusHeader,
      "",
      `• <b>Telegram Gateway:</b> Online`,
      `• <b>Gemini AI Engine:</b> ${
        geminiHealth.ok
          ? `Online (${geminiHealth.activeModel ?? geminiHealth.configuredModel}, ${geminiHealth.latencyMs}ms)`
          : `Unavailable (${geminiHealth.error ?? "check configuration"})`
      }`,
      `• <b>Memory Database:</b> ${
        dbHealth.ok ? `Connected (${dbHealth.latencyMs}ms)` : "Unavailable"
      }`,
      `• <b>Assistant Release:</b> Phase 1 — Core Conversational AI`,
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    logger.error("Failed to handle /status command", { err });
    await ctx.reply(getSafeUserErrorMessage(err));
  }
}

export function registerBotCommands(bot: Telegraf): void {
  bot.command("start", handleStartCommand);
  bot.command("help", handleHelpCommand);
  bot.command("about", handleAboutCommand);
  bot.command("reset", handleResetCommand);
  bot.command("status", handleStatusCommand);
}

export interface ProfileSyncResult {
  commands: boolean;
  name: boolean;
  shortDescription: boolean;
  description: boolean;
  menuButton: boolean;
  errors: string[];
}

/**
 * Automates all Telegram profile properties supported by the Telegram Bot API.
 * Note: Bot username and profile photo (/setuserpic) cannot be set via Bot API
 * and must be configured through @BotFather.
 */
export async function syncTelegramBotProfile(
  bot: Telegraf
): Promise<ProfileSyncResult> {
  const result: ProfileSyncResult = {
    commands: false,
    name: false,
    shortDescription: false,
    description: false,
    menuButton: false,
    errors: [],
  };

  try {
    await bot.telegram.setMyCommands([...BOT_COMMANDS_SPEC]);
    result.commands = true;
  } catch (err) {
    result.errors.push(`setMyCommands: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await bot.telegram.callApi("setMyName", { name: NEXA_BRAND.displayName });
    result.name = true;
  } catch (err) {
    result.errors.push(`setMyName: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await bot.telegram.callApi("setMyShortDescription", {
      short_description: NEXA_BRAND.about,
    });
    result.shortDescription = true;
  } catch (err) {
    result.errors.push(
      `setMyShortDescription: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await bot.telegram.callApi("setMyDescription", {
      description: NEXA_BRAND.shortDescription,
    });
    result.description = true;
  } catch (err) {
    result.errors.push(
      `setMyDescription: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await bot.telegram.setChatMenuButton({
      menuButton: { type: "commands" },
    });
    result.menuButton = true;
  } catch (err) {
    result.errors.push(
      `setChatMenuButton: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  logger.info("Synchronized Telegram bot profile via Bot API", {
    ...result,
  });

  return result;
}
