import { NextRequest, NextResponse } from "next/server";
import type { Update } from "telegraf/types";
import { getEnv, isTelegramConfigured } from "@/config/env";
import { verifyConstantTimeSecret } from "@/middleware/error-handler";
import { handleWebhookUpdate } from "@/telegram/bot";
import { logger } from "@/utils/logger";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isTelegramConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Telegram bot is not configured" },
      { status: 503 }
    );
  }

  const env = getEnv();

  // Enforce Telegram secret token validation whenever WEBHOOK_SECRET is set
  if (env.WEBHOOK_SECRET) {
    const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!verifyConstantTimeSecret(providedSecret, env.WEBHOOK_SECRET)) {
      logger.warn("Rejected Telegram webhook with invalid or missing secret token");
      return NextResponse.json(
        { ok: false, error: "Unauthorized webhook request" },
        { status: 401 }
      );
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { update_id?: unknown }).update_id !== "number"
  ) {
    return NextResponse.json(
      { ok: false, error: "Malformed Telegram update payload" },
      { status: 400 }
    );
  }

  try {
    await handleWebhookUpdate(body as Update);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("Error processing Telegram webhook update", {
      updateId: (body as { update_id: number }).update_id,
      err,
    });
    // Return 200 after logging if update processing failed internally so Telegram
    // doesn't endlessly retry bad payloads, or 500 for transient DB outages.
    return NextResponse.json({ ok: false, error: "Update processing failed" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/telegram/webhook",
    method: "POST",
    secretHeaderRequired: Boolean(getEnv().WEBHOOK_SECRET),
  });
}
