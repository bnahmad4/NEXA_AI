import { Markup } from "telegraf";

export const CALLBACK_ACTIONS = {
  START_CHATTING: "nexa:start_chatting",
  ABOUT: "nexa:about",
  HELP: "nexa:help",
  RESET_PROMPT: "nexa:reset_prompt",
  RESET_CONFIRM: "nexa:reset_confirm",
  RESET_CANCEL: "nexa:reset_cancel",
} as const;

/**
 * Official Welcome inline keyboard for NEXA AI.
 */
export function buildWelcomeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Start Chatting", CALLBACK_ACTIONS.START_CHATTING),
      Markup.button.callback("About NEXA AI", CALLBACK_ACTIONS.ABOUT),
    ],
    [
      Markup.button.callback("Help & Commands", CALLBACK_ACTIONS.HELP),
      Markup.button.callback("Reset Conversation", CALLBACK_ACTIONS.RESET_PROMPT),
    ],
  ]);
}

/**
 * Confirmation keyboard shown when a user clicks Reset Conversation from an inline menu.
 */
export function buildResetConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Yes, Reset Memory", CALLBACK_ACTIONS.RESET_CONFIRM),
      Markup.button.callback("Keep Context", CALLBACK_ACTIONS.RESET_CANCEL),
    ],
  ]);
}

/**
 * Light navigation keyboard for informational views (/help, /about).
 */
export function buildInfoKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Start Chatting", CALLBACK_ACTIONS.START_CHATTING),
      Markup.button.callback("Reset Conversation", CALLBACK_ACTIONS.RESET_PROMPT),
    ],
  ]);
}
