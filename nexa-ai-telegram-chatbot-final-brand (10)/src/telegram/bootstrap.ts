import { getEnv, isTelegramConfigured } from "@/config/env";
import { startBotPolling } from "@/telegram/bot";
import { logger } from "@/utils/logger";

export async function bootstrapTelegramRuntime(): Promise<void> {
  const isBuildPhase =
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.argv.some((arg) => arg.includes("build") || arg.includes("typegen"));

  if (isBuildPhase || process.env.NODE_ENV === "test") {
    return;
  }

  const env = getEnv();
  if (env.TELEGRAM_MODE === "polling" && isTelegramConfigured()) {
    logger.info("Bootstrapping NEXA AI Telegram bot in long-polling mode");
    startBotPolling({ syncProfile: true }).catch((err) => {
      logger.error("Automatic Telegram polling startup failed", { err });
    });
  }
}
