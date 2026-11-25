import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "telegraf";
import { NextRequest } from "next/server";
import { NEXA_BRAND } from "@/ai/prompts";
import { checkDatabaseHealth } from "@/db";
import {
  deleteUserDataByTelegramId,
  upsertTelegramUser,
} from "@/services/user.service";
import {
  getConversationForUser,
  getOrCreateActiveConversation,
  resetUserConversation,
} from "@/services/conversation.service";
import {
  claimTelegramUpdate,
  getRecentConversationMessages,
  saveMessage,
} from "@/services/message.service";
import {
  handleAboutCommand,
  handleHelpCommand,
  handleResetCommand,
  handleStartCommand,
} from "@/telegram/commands";
import { processTextMessage } from "@/telegram/handlers";
import { getTelegramRateLimiter } from "@/middleware/rate-limit";
import { POST as webhookPost } from "@/app/api/telegram/webhook/route";

const TEST_USER_A_TG_ID = "9900001001";
const TEST_USER_B_TG_ID = "9900001002";

function createMockTelegramContext(params: {
  telegramId: number;
  firstName?: string;
  username?: string;
  text?: string;
  updateId?: number;
}) {
  const replies: Array<{ text: string; extra?: unknown }> = [];
  const chatActions: string[] = [];

  const ctx = {
    from: {
      id: params.telegramId,
      is_bot: false,
      first_name: params.firstName ?? "TestUser",
      username: params.username ?? `user_${params.telegramId}`,
      language_code: "en",
    },
    chat: {
      id: params.telegramId,
      type: "private",
    },
    update: {
      update_id: params.updateId ?? Math.floor(Math.random() * 1_000_000_000),
    },
    message: {
      message_id: Math.floor(Math.random() * 100_000),
      text: params.text ?? "",
    },
    reply: vi.fn(async (text: string, extra?: unknown) => {
      replies.push({ text, extra });
      return { message_id: replies.length };
    }),
    sendChatAction: vi.fn(async (action: string) => {
      chatActions.push(action);
      return true;
    }),
  } as unknown as Context;

  return { ctx, replies, chatActions };
}

describe("PostgreSQL Persistence, User Isolation & Telegram Handlers", () => {
  beforeAll(async () => {
    const health = await checkDatabaseHealth();
    expect(health.ok).toBe(true);
    await deleteUserDataByTelegramId(TEST_USER_A_TG_ID);
    await deleteUserDataByTelegramId(TEST_USER_B_TG_ID);
  });

  afterAll(async () => {
    await deleteUserDataByTelegramId(TEST_USER_A_TG_ID);
    await deleteUserDataByTelegramId(TEST_USER_B_TG_ID);
  });

  it("persists per-user conversations and enforces strict user isolation", async () => {
    const userA = await upsertTelegramUser({
      telegramId: TEST_USER_A_TG_ID,
      username: "alice_test",
      firstName: "Alice",
    });
    const userB = await upsertTelegramUser({
      telegramId: TEST_USER_B_TG_ID,
      username: "bob_test",
      firstName: "Bob",
    });

    const convA = await getOrCreateActiveConversation(userA.id);
    const convB = await getOrCreateActiveConversation(userB.id);

    await saveMessage({
      conversationId: convA.id,
      userId: userA.id,
      role: "user",
      content: "Alice private project codename is ORION",
    });
    await saveMessage({
      conversationId: convB.id,
      userId: userB.id,
      role: "user",
      content: "Bob private project codename is TITAN",
    });

    // Cross-user access must return null / empty
    const crossCheck = await getConversationForUser(convA.id, userB.id);
    expect(crossCheck).toBeNull();

    const aliceHistory = await getRecentConversationMessages(convA.id, userA.id, 10);
    const bobHistory = await getRecentConversationMessages(convB.id, userB.id, 10);
    const bobTryingAlice = await getRecentConversationMessages(convA.id, userB.id, 10);

    expect(aliceHistory.map((m) => m.content)).toContain("Alice private project codename is ORION");
    expect(aliceHistory.map((m) => m.content)).not.toContain("Bob private project codename is TITAN");
    expect(bobHistory.map((m) => m.content)).toContain("Bob private project codename is TITAN");
    expect(bobTryingAlice).toHaveLength(0);
  });

  it("resets only the requesting user's active conversation without affecting other users", async () => {
    const userA = await upsertTelegramUser({ telegramId: TEST_USER_A_TG_ID, firstName: "Alice" });
    const userB = await upsertTelegramUser({ telegramId: TEST_USER_B_TG_ID, firstName: "Bob" });

    const { previousCount, activeConversation: freshA } = await resetUserConversation(userA.id);
    expect(previousCount).toBeGreaterThanOrEqual(1);

    const freshAHistory = await getRecentConversationMessages(freshA.id, userA.id, 10);
    expect(freshAHistory).toHaveLength(0);

    // Bob's conversation must remain untouched
    const convB = await getOrCreateActiveConversation(userB.id);
    const bobHistory = await getRecentConversationMessages(convB.id, userB.id, 10);
    expect(bobHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates repeated Telegram update_ids atomically", async () => {
    const testUpdateId = 880_000_000 + Math.floor(Math.random() * 100_000);
    const firstClaim = await claimTelegramUpdate(testUpdateId, TEST_USER_A_TG_ID);
    const duplicateClaim = await claimTelegramUpdate(testUpdateId, TEST_USER_A_TG_ID);

    expect(firstClaim).toBe(true);
    expect(duplicateClaim).toBe(false);
  });

  it("handles /start, /help, /about, and /reset commands with NEXA AI branding and inline keyboard", async () => {
    const startHarness = createMockTelegramContext({
      telegramId: Number(TEST_USER_A_TG_ID),
      firstName: "Alice",
    });
    await handleStartCommand(startHarness.ctx);
    expect(startHarness.replies).toHaveLength(1);
    expect(startHarness.replies[0].text).toBe(NEXA_BRAND.welcomeMessage);

    const extra = startHarness.replies[0].extra as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> };
    };
    const buttonLabels = extra.reply_markup?.inline_keyboard?.flat().map((b) => b.text) ?? [];
    expect(buttonLabels).toEqual([
      "Start Chatting",
      "About NEXA AI",
      "Help & Commands",
      "Reset Conversation",
    ]);

    const helpHarness = createMockTelegramContext({ telegramId: Number(TEST_USER_A_TG_ID) });
    await handleHelpCommand(helpHarness.ctx);
    expect(helpHarness.replies[0].text).toContain("/reset");
    expect(helpHarness.replies[0].text).toContain("/status");

    const aboutHarness = createMockTelegramContext({ telegramId: Number(TEST_USER_A_TG_ID) });
    await handleAboutCommand(aboutHarness.ctx);
    expect(aboutHarness.replies[0].text).toContain("NEXA AI");

    const resetHarness = createMockTelegramContext({ telegramId: Number(TEST_USER_A_TG_ID) });
    await handleResetCommand(resetHarness.ctx);
    expect(resetHarness.replies[0].text).toContain("Conversation Reset");
  });

  it("processes a text conversation turn with typing indicator, memory, and graceful Gemini failure handling", async () => {
    getTelegramRateLimiter().reset(TEST_USER_A_TG_ID);

    const mockGenerate = vi.fn(async ({ history, userMessage }) => ({
      text: `Echo (${history.length} prior turns): **${userMessage}**`,
      modelUsed: "gemini-3.6-flash",
      latencyMs: 42,
      contextTurnsUsed: history.length,
      droppedTurns: 0,
      usedFallbackModel: false,
    }));

    // Turn 1
    const turn1 = createMockTelegramContext({
      telegramId: Number(TEST_USER_A_TG_ID),
      text: "Hello NEXA",
    });
    await processTextMessage(turn1.ctx, "Hello NEXA", { generateReply: mockGenerate });
    expect(turn1.chatActions).toContain("typing");
    expect(turn1.replies[0].text).toContain("<b>Hello NEXA</b>");

    // Turn 2 should see 2 prior turns (user + assistant from Turn 1)
    const turn2 = createMockTelegramContext({
      telegramId: Number(TEST_USER_A_TG_ID),
      text: "Do you remember me?",
    });
    await processTextMessage(turn2.ctx, "Do you remember me?", { generateReply: mockGenerate });
    expect(turn2.replies[0].text).toContain("2 prior turns");

    // Simulated Gemini failure -> safe user-friendly error
    const failTurn = createMockTelegramContext({
      telegramId: Number(TEST_USER_A_TG_ID),
      text: "Trigger failure",
    });
    await processTextMessage(failTurn.ctx, "Trigger failure", {
      generateReply: async () => {
        throw new Error("503 UNAVAILABLE upstream");
      },
    });
    expect(failTurn.replies[0].text).toContain("high demand");
    expect(failTurn.replies[0].text).not.toContain("503");
  });

  it("enforces webhook secret authentication and rejects malformed payloads", async () => {
    const unauthorizedReq = new NextRequest("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong_secret",
      },
      body: JSON.stringify({ update_id: 123 }),
    });
    const unauthRes = await webhookPost(unauthorizedReq);
    expect(unauthRes.status).toBe(401);

    const malformedReq = new NextRequest("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": process.env.WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify({ invalid: true }),
    });
    const badRes = await webhookPost(malformedReq);
    expect(badRes.status).toBe(400);
  });
});
