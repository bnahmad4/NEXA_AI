import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/config/env";
import { verifyConstantTimeSecret } from "@/middleware/error-handler";
import {
  deleteTelegramWebhook,
  setProductionWebhook,
  startBotPolling,
  stopBotPolling,
  syncBotProfileNow,
} from "@/telegram/bot";
import { logger } from "@/utils/logger";

export const dynamic = "force-dynamic";

const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_polling") }),
  z.object({ action: z.literal("stop_polling") }),
  z.object({ action: z.literal("sync_profile") }),
  z.object({
    action: z.literal("set_webhook"),
    webhookUrl: z.string().url().startsWith("https://", "Webhook URL must use HTTPS"),
  }),
  z.object({ action: z.literal("delete_webhook") }),
]);

export async function POST(request: NextRequest) {
  const env = getEnv();

  // If ADMIN_API_KEY is configured, require matching header
  if (env.ADMIN_API_KEY) {
    const provided = request.headers.get("x-admin-api-key");
    if (!verifyConstantTimeSecret(provided, env.ADMIN_API_KEY)) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized admin control request" },
        { status: 401 }
      );
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = controlSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid control action" },
      { status: 400 }
    );
  }

  try {
    switch (parsed.data.action) {
      case "start_polling": {
        const state = await startBotPolling({ syncProfile: false });
        return NextResponse.json({ ok: state.pollingActive, state });
      }
      case "stop_polling": {
        const state = await stopBotPolling("ADMIN_CONSOLE");
        return NextResponse.json({ ok: true, state });
      }
      case "sync_profile": {
        const result = await syncBotProfileNow();
        return NextResponse.json({
          ok: result.errors.length === 0,
          result,
        });
      }
      case "set_webhook": {
        const result = await setProductionWebhook(parsed.data.webhookUrl);
        return NextResponse.json(result);
      }
      case "delete_webhook": {
        const result = await deleteTelegramWebhook();
        return NextResponse.json(result);
      }
    }
  } catch (err) {
    logger.error("Bot control action failed", { action: parsed.data.action, err });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Action failed",
      },
      { status: 500 }
    );
  }
}
