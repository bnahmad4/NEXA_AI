import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateNexaReply } from "@/ai/gemini";
import { getSafeUserErrorMessage, sanitizeUserMessage } from "@/middleware/error-handler";
import {
  getOrCreateActiveConversation,
  resetUserConversation,
} from "@/services/conversation.service";
import {
  getRecentConversationMessages,
  saveMessage,
} from "@/services/message.service";
import { upsertTelegramUser } from "@/services/user.service";

export const dynamic = "force-dynamic";

const PROBE_TELEGRAM_ID = "nexa_diagnostic_probe";

const probeSchema = z.object({
  action: z.enum(["send", "reset"]).default("send"),
  message: z.string().optional(),
});

/**
 * Real end-to-end diagnostic endpoint that exercises PostgreSQL conversation
 * persistence and the real Google Gemini API (never simulated).
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = probeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  try {
    const user = await upsertTelegramUser({
      telegramId: PROBE_TELEGRAM_ID,
      username: "nexa_ops_probe",
      firstName: "NEXA Diagnostics",
      isBot: false,
    });

    if (parsed.data.action === "reset") {
      const { previousCount, activeConversation } = await resetUserConversation(user.id);
      return NextResponse.json({
        ok: true,
        reset: true,
        previousCount,
        conversationId: activeConversation.id,
      });
    }

    const sanitized = sanitizeUserMessage(parsed.data.message ?? "");
    if (!sanitized.valid) {
      return NextResponse.json({ ok: false, error: sanitized.reason }, { status: 400 });
    }

    const conversation = await getOrCreateActiveConversation(user.id);
    const history = await getRecentConversationMessages(conversation.id, user.id, 20);

    const reply = await generateNexaReply({
      history: history.map((m) => ({ role: m.role, content: m.content })),
      userMessage: sanitized.text,
      userName: "Engineer",
    });

    await saveMessage({
      conversationId: conversation.id,
      userId: user.id,
      role: "user",
      content: sanitized.text,
      metadata: { phase: 1 },
    });

    await saveMessage({
      conversationId: conversation.id,
      userId: user.id,
      role: "assistant",
      content: reply.text,
      modelUsed: reply.modelUsed,
      latencyMs: reply.latencyMs,
      metadata: { phase: 1 },
    });

    return NextResponse.json({
      ok: true,
      reply: reply.text,
      modelUsed: reply.modelUsed,
      latencyMs: reply.latencyMs,
      contextTurnsUsed: reply.contextTurnsUsed,
      usedFallbackModel: reply.usedFallbackModel,
      conversationId: conversation.id,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: getSafeUserErrorMessage(err) },
      { status: 500 }
    );
  }
}
