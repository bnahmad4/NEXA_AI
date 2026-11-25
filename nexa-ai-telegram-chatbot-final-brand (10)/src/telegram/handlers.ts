import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { generateNexaReply } from "@/ai/gemini";
import { ABOUT_MESSAGE_HTML, HELP_MESSAGE_HTML } from "@/ai/prompts";
import {
  getSafeUserErrorMessage,
  sanitizeUserMessage,
} from "@/middleware/error-handler";
import { getTelegramRateLimiter } from "@/middleware/rate-limit";
import {
  getOrCreateActiveConversation,
  resetUserConversation,
} from "@/services/conversation.service";
import {
  claimTelegramUpdate,
  getRecentConversationMessages,
  saveMessage,
} from "@/services/message.service";
import {
  getUserPreferences,
  upsertTelegramUser,
} from "@/services/user.service";
import { formatForTelegramChunks } from "@/telegram/format";
import {
  buildInfoKeyboard,
  buildResetConfirmKeyboard,
  CALLBACK_ACTIONS,
} from "@/telegram/keyboards";
import { logger } from "@/utils/logger";

export interface TextPipelineDeps {
  generateReply?: typeof generateNexaReply;
}

/**
 * Starts a Telegram "typing..." chat action indicator immediately and refreshes
 * it every 4 seconds (Telegram expires chat actions after ~5 seconds).
 */
function startTypingIndicator(ctx: Context): () => void {
  let stopped = false;

  const sendTyping = () => {
    if (stopped) return;
    ctx.sendChatAction("typing").catch(() => undefined);
  };

  sendTyping();
  const interval = setInterval(sendTyping, 4000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/**
 * Sends formatted HTML chunks to the Telegram user, falling back to plain text
 * if Telegram rejects HTML markup for any edge-case character sequence.
 */
async function sendFormattedReply(ctx: Context, rawMarkdown: string): Promise<void> {
  const chunks = formatForTelegramChunks(rawMarkdown);

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk.html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.warn("Telegram HTML parse failed for chunk; falling back to plain text", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(chunk.plain, {
        link_preview_options: { is_disabled: true },
      });
    }
  }
}

export async function processTextMessage(
  ctx: Context,
  rawText: string,
  deps?: TextPipelineDeps
): Promise<void> {
  if (!ctx.from) return;

  const telegramUserId = String(ctx.from.id);
  const updateId = ctx.update?.update_id;

  // 1. Protect against duplicate Telegram update processing (webhook retries / restarts)
  if (typeof updateId === "number") {
    try {
      const isNew = await claimTelegramUpdate(updateId, telegramUserId);
      if (!isNew) {
        logger.debug("Skipping duplicate Telegram update", { updateId });
        return;
      }
    } catch (err) {
      logger.warn("Update deduplication check failed; continuing safely", { err });
    }
  }

  // 2. Validate & sanitize incoming user message
  const sanitized = sanitizeUserMessage(rawText);
  if (!sanitized.valid) {
    await ctx.reply(sanitized.reason);
    return;
  }

  // 3. Enforce per-user sliding-window rate limit
  const rateLimit = getTelegramRateLimiter().check(telegramUserId);
  if (!rateLimit.allowed) {
    await ctx.reply(
      `You're sending messages a little too fast. Please wait about ${rateLimit.retryAfterSeconds} second${
        rateLimit.retryAfterSeconds === 1 ? "" : "s"
      } and try again.`
    );
    return;
  }

  // 4. Begin typing indicator while fetching memory and calling Gemini
  const stopTyping = startTypingIndicator(ctx);

  try {
    // 5. Upsert Telegram user & load private preferences + active conversation
    const user = await upsertTelegramUser({
      telegramId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      languageCode: ctx.from.language_code,
      isBot: ctx.from.is_bot,
    });

    if (user.isBlocked) {
      await ctx.reply("Access to this assistant is currently restricted for your account.");
      return;
    }

    const [preferences, conversation] = await Promise.all([
      getUserPreferences(user.id),
      getOrCreateActiveConversation(user.id),
    ]);

    // 6. Retrieve strictly user-scoped conversation history
    const history = await getRecentConversationMessages(
      conversation.id,
      user.id,
      preferences.maxHistoryMessages
    );

    const telegramMessageId =
      ctx.message && "message_id" in ctx.message ? ctx.message.message_id : null;

    // 7. Generate intelligent reply via real Google Gemini API
    const generator = deps?.generateReply ?? generateNexaReply;
    const aiResult = await generator({
      history: history.map((m) => ({ role: m.role, content: m.content })),
      userMessage: sanitized.text,
      userName: user.firstName ?? user.username,
      modelOverride:
        conversation.settings?.modelOverride ?? preferences.preferredModel,
      temperature:
        conversation.settings?.temperature ?? preferences.temperature,
      responseStyle:
        conversation.settings?.responseStyle ?? preferences.responseStyle,
      maxHistoryMessages: preferences.maxHistoryMessages,
    });

    // 8. Persist both user message and AI assistant response in PostgreSQL
    await saveMessage({
      conversationId: conversation.id,
      userId: user.id,
      role: "user",
      content: sanitized.text,
      telegramMessageId,
      contentType: "text",
      metadata: { phase: 1 },
    });

    await saveMessage({
      conversationId: conversation.id,
      userId: user.id,
      role: "assistant",
      content: aiResult.text,
      contentType: "text",
      modelUsed: aiResult.modelUsed,
      latencyMs: aiResult.latencyMs,
      metadata: { phase: 1 },
    });

    stopTyping();

    // 9. Deliver cleanly formatted response to the user
    await sendFormattedReply(ctx, aiResult.text);

    logger.info("Processed Telegram text conversation turn", {
      telegramUserId,
      conversationId: conversation.id,
      modelUsed: aiResult.modelUsed,
      latencyMs: aiResult.latencyMs,
      contextTurnsUsed: aiResult.contextTurnsUsed,
    });
  } catch (err) {
    stopTyping();
    const safeMsg = getSafeUserErrorMessage(err);
    await ctx.reply(safeMsg).catch(() => undefined);
  }
}

export async function handleCallbackAction(ctx: Context): Promise<void> {
  const callbackData =
    ctx.callbackQuery && "data" in ctx.callbackQuery
      ? ctx.callbackQuery.data
      : undefined;

  if (!callbackData) {
    await ctx.answerCbQuery().catch(() => undefined);
    return;
  }

  try {
    switch (callbackData) {
      case CALLBACK_ACTIONS.START_CHATTING:
        await ctx.answerCbQuery("Ready to chat!");
        await ctx.reply(
          "<b>NEXA AI is ready.</b>\n\nGo ahead and type any question, coding problem, writing task, or idea below—I'll remember our conversation as we go!",
          { parse_mode: "HTML" }
        );
        break;

      case CALLBACK_ACTIONS.ABOUT:
        await ctx.answerCbQuery();
        await ctx.reply(ABOUT_MESSAGE_HTML, {
          parse_mode: "HTML",
          ...buildInfoKeyboard(),
        });
        break;

      case CALLBACK_ACTIONS.HELP:
        await ctx.answerCbQuery();
        await ctx.reply(HELP_MESSAGE_HTML, {
          parse_mode: "HTML",
          ...buildInfoKeyboard(),
        });
        break;

      case CALLBACK_ACTIONS.RESET_PROMPT:
        await ctx.answerCbQuery();
        await ctx.reply(
          "<b>Reset Conversation Memory?</b>\n\nThis will clear your current context so NEXA AI starts fresh on your next message.",
          {
            parse_mode: "HTML",
            ...buildResetConfirmKeyboard(),
          }
        );
        break;

      case CALLBACK_ACTIONS.RESET_CONFIRM:
        if (ctx.from) {
          const user = await upsertTelegramUser({
            telegramId: ctx.from.id,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
            languageCode: ctx.from.language_code,
          });
          const { previousCount } = await resetUserConversation(user.id);
          await ctx.answerCbQuery("Conversation reset");
          await ctx.reply(
            `<b>Conversation Reset</b>\n\n${
              previousCount > 0
                ? `Cleared ${previousCount} message${previousCount === 1 ? "" : "s"} from active memory.`
                : "Your context was already fresh."
            }\nAsk me anything to begin a new thread!`,
            { parse_mode: "HTML" }
          );
        } else {
          await ctx.answerCbQuery("Unable to identify account");
        }
        break;

      case CALLBACK_ACTIONS.RESET_CANCEL:
        await ctx.answerCbQuery("Kept your current context");
        await ctx.reply("Got it—your conversation memory is intact. Feel free to continue!");
        break;

      default:
        await ctx.answerCbQuery();
    }
  } catch (err) {
    logger.error("Failed to handle callback query", { callbackData, err });
    await ctx.answerCbQuery("Something went wrong").catch(() => undefined);
  }
}

export function registerBotHandlers(bot: Telegraf): void {
  // Inline button callback actions
  bot.on("callback_query", handleCallbackAction);

  // Normal text messages (ignores slash commands already handled by bot.command)
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply(
        "I didn't recognize that command. Type /help to see the available NEXA AI commands, or simply send a normal message to chat!"
      );
      return;
    }
    await processTextMessage(ctx, text);
  });

  // Honest Phase 2 roadmap response for multimodal media uploads
  bot.on([message("photo"), message("document"), message("voice"), message("audio"), message("video")], async (ctx) => {
    await ctx.reply(
      "<b>Text Assistant Active (Phase 1)</b>\n\nI currently specialize in text-based conversations. Image understanding, PDF/document analysis, and voice transcription are architected for <b>Phase 2</b> and not yet active.\n\nIn the meantime, feel free to paste text or describe your question and I'll gladly help!",
      { parse_mode: "HTML" }
    );
  });

  // Global Telegraf error boundary
  bot.catch((err, ctx) => {
    logger.error("Unhandled Telegraf update error", {
      updateType: ctx.updateType,
      err,
    });
  });
}
