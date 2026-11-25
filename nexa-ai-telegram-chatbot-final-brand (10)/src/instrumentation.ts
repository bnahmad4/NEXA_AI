export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapTelegramRuntime } = await import("@/telegram/bootstrap");
    await bootstrapTelegramRuntime();
  }
}
