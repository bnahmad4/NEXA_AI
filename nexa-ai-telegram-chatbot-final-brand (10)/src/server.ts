import "dotenv/config";
import express from "express";
import type { Update } from "telegraf/types";
import { getEnv, isTelegramConfigured } from "@/config/env";
import { checkDatabaseHealth, pool } from "@/db";
import { verifyConstantTimeSecret } from "@/middleware/error-handler";
import {
  getBotRuntimeState,
  handleWebhookUpdate,
  setProductionWebhook,
  startBotPolling,
  stopBotPolling,
  syncBotProfileNow,
} from "@/telegram/bot";
import { logger } from "@/utils/logger";

export function createExpressApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Health-check endpoint for Render, Railway, Docker, and load balancers
  app.get("/health", async (_req, res) => {
    const dbHealth = await checkDatabaseHealth();
    const runtime = getBotRuntimeState();
    const status = dbHealth.ok ? 200 : 503;

    res.status(status).json({
      ok: dbHealth.ok,
      service: "nexa-ai",
      timestamp: new Date().toISOString(),
      database: dbHealth,
      telegram: runtime,
    });
  });

  // Production Telegram webhook endpoint
  app.post("/api/telegram/webhook", async (req, res) => {
    const env = getEnv();
    if (!isTelegramConfigured()) {
      res.status(503).json({ ok: false, error: "Telegram bot token not configured" });
      return;
    }

    if (env.WEBHOOK_SECRET) {
      const provided = req.header("x-telegram-bot-api-secret-token");
      if (!verifyConstantTimeSecret(provided, env.WEBHOOK_SECRET)) {
        logger.warn("Express webhook rejected invalid secret token");
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
    }

    const update = req.body as Partial<Update> | undefined;
    if (!update || typeof update.update_id !== "number") {
      res.status(400).json({ ok: false, error: "Invalid Telegram update payload" });
      return;
    }

    try {
      await handleWebhookUpdate(update as Update);
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error("Express webhook failed to process update", {
        updateId: update.update_id,
        err,
      });
      res.status(500).json({ ok: false, error: "Internal processing error" });
    }
  });

  return app;
}

export async function startStandaloneServer() {
  const env = getEnv();
  const app = createExpressApp();

  const server = app.listen(env.PORT, async () => {
    logger.info("NEXA AI Express server listening", {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      telegramMode: env.TELEGRAM_MODE,
    });

    if (!isTelegramConfigured()) {
      logger.warn("TELEGRAM_BOT_TOKEN is not set; skipping Telegram bot startup");
      return;
    }

    try {
      if (env.TELEGRAM_MODE === "webhook" && env.WEBHOOK_URL) {
        await syncBotProfileNow();
        await setProductionWebhook(env.WEBHOOK_URL, env.WEBHOOK_SECRET);
      } else if (env.TELEGRAM_MODE === "polling") {
        await startBotPolling({ syncProfile: true });
      }
    } catch (err) {
      logger.error("Telegram startup failed in standalone Express server", { err });
    }
  });

  const shutdown = async (signal: string) => {
    logger.info("Shutting down NEXA AI server", { signal });
    await stopBotPolling(signal);
    server.close(async () => {
      await pool.end().catch(() => undefined);
      process.exit(0);
    });
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}

// Only auto-start when invoked directly via CLI (never when imported by Next.js or tests)
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1]?.endsWith("server.ts");

if (isDirectRun) {
  void startStandaloneServer();
}
