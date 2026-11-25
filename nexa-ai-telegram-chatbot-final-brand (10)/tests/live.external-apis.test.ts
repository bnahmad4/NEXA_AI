import "dotenv/config";
import { describe, expect, it } from "vitest";
import { isGeminiConfigured, isTelegramConfigured } from "@/config/env";
import { generateNexaReply } from "@/ai/gemini";
import { getTelegramBotLiveInfo, syncBotProfileNow } from "@/telegram/bot";

describe("Live External Integrations (Telegram Bot API & Google Gemini API)", () => {
  it("connects to the real Telegram Bot API and syncs NEXA AI profile settings", async () => {
    if (!isTelegramConfigured()) {
      throw new Error("TELEGRAM_BOT_TOKEN must be configured in .env for live verification");
    }

    const info = await getTelegramBotLiveInfo();
    expect(info.ok).toBe(true);
    expect(info.bot?.id).toBeGreaterThan(0);
    expect(info.bot?.username).toBeTruthy();

    const sync = await syncBotProfileNow();
    expect(sync.commands).toBe(true);
    expect(sync.shortDescription).toBe(true);
    expect(sync.description).toBe(true);
    expect(sync.menuButton).toBe(true);
  });

  it("generates genuine contextual multi-turn responses from Google Gemini API", async () => {
    if (!isGeminiConfigured()) {
      throw new Error("GEMINI_API_KEY must be configured in .env for live verification");
    }

    const turn1 = await generateNexaReply({
      history: [],
      userMessage: "Remember this exact secret code word for my next message: QUANTUM-742. Just reply 'Noted'.",
      userName: "Verifier",
    });

    expect(turn1.text.length).toBeGreaterThan(0);
    expect(turn1.modelUsed).toContain("gemini");

    const turn2 = await generateNexaReply({
      history: [
        {
          role: "user",
          content: "Remember this exact secret code word for my next message: QUANTUM-742. Just reply 'Noted'.",
        },
        {
          role: "assistant",
          content: turn1.text,
        },
      ],
      userMessage: "What was the exact secret code word I just asked you to remember?",
      userName: "Verifier",
    });

    expect(turn2.text.toUpperCase()).toContain("QUANTUM-742");
  });
});
