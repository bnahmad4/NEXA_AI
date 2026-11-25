import { checkDatabaseHealth } from "@/db";
import { getBotRuntimeState } from "@/telegram/bot";

export const dynamic = "force-dynamic";

export async function GET() {
  const dbHealth = await checkDatabaseHealth();
  const botRuntime = getBotRuntimeState();

  if (!dbHealth.ok) {
    return Response.json(
      {
        ok: false,
        service: "nexa-ai",
        timestamp: new Date().toISOString(),
        database: { ok: false, latencyMs: dbHealth.latencyMs },
        telegram: botRuntime,
      },
      { status: 500 }
    );
  }

  return Response.json({
    ok: true,
    service: "nexa-ai",
    timestamp: new Date().toISOString(),
    database: { ok: true, latencyMs: dbHealth.latencyMs },
    telegram: botRuntime,
  });
}
