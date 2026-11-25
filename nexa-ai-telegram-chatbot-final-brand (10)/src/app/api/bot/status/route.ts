import { NextRequest, NextResponse } from "next/server";
import { checkGeminiHealth } from "@/ai/gemini";
import { BOT_COMMANDS_SPEC, NEXA_BRAND } from "@/ai/prompts";
import { getEnv, isGeminiConfigured } from "@/config/env";
import { checkDatabaseHealth } from "@/db";
import { getAggregateSystemStats } from "@/services/user.service";
import { getTelegramBotLiveInfo } from "@/telegram/bot";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const probeGemini = request.nextUrl.searchParams.get("probeGemini") === "true";
  const env = getEnv();

  const [dbHealth, telegramInfo, stats, geminiHealth] = await Promise.all([
    checkDatabaseHealth(),
    getTelegramBotLiveInfo(),
    getAggregateSystemStats().catch(() => ({
      totalUsers: 0,
      totalConversations: 0,
      activeConversations: 0,
      totalMessages: 0,
    })),
    probeGemini
      ? checkGeminiHealth()
      : Promise.resolve({
          ok: isGeminiConfigured(),
          configured: isGeminiConfigured(),
          configuredModel: env.GEMINI_MODEL,
          activeModel: env.GEMINI_MODEL,
          latencyMs: 0,
          probed: false,
        }),
  ]);

  return NextResponse.json({
    ok: dbHealth.ok && telegramInfo.ok,
    timestamp: new Date().toISOString(),
    brand: {
      officialName: NEXA_BRAND.officialName,
      displayName: NEXA_BRAND.displayName,
      shortDescription: NEXA_BRAND.shortDescription,
      about: NEXA_BRAND.about,
      welcomeMessage: NEXA_BRAND.welcomeMessage,
      avatarPath: "/assets/nexa-ai-avatar.png",
      commands: BOT_COMMANDS_SPEC,
    },
    telegram: telegramInfo,
    gemini: {
      ...geminiHealth,
      fallbackModels: env.fallbackModels,
      probed: probeGemini,
    },
    database: {
      ...dbHealth,
      stats,
    },
    security: {
      webhookSecretConfigured: Boolean(env.WEBHOOK_SECRET),
      adminApiKeyConfigured: Boolean(env.ADMIN_API_KEY),
      rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      maxHistoryMessages: env.MAX_HISTORY_MESSAGES,
      maxContextChars: env.MAX_CONTEXT_CHARS,
    },
  });
}
