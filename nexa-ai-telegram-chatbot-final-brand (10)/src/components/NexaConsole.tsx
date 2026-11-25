"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Globe,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  AlertTriangle,
} from "lucide-react";

interface BotStatusPayload {
  ok: boolean;
  timestamp: string;
  brand: {
    officialName: string;
    displayName: string;
    shortDescription: string;
    about: string;
    welcomeMessage: string;
    avatarPath: string;
    commands: Array<{ command: string; description: string }>;
  };
  telegram: {
    ok: boolean;
    configured: boolean;
    bot?: {
      id: number;
      username: string;
      firstName: string;
      deepLink: string;
    };
    webhook?: {
      url: string;
      pendingUpdateCount: number;
      lastErrorMessage?: string;
    };
    runtime: {
      configured: boolean;
      mode: string;
      pollingActive: boolean;
      startedAt: string | null;
      lastError: string | null;
      profileSyncedAt: string | null;
    };
    error?: string;
  };
  gemini: {
    ok: boolean;
    configured: boolean;
    configuredModel: string;
    activeModel?: string;
    fallbackModels: string[];
    latencyMs: number;
    probed: boolean;
    error?: string;
  };
  database: {
    ok: boolean;
    latencyMs: number;
    error?: string;
    stats: {
      totalUsers: number;
      activeConversations: number;
      totalConversations: number;
      totalMessages: number;
    };
  };
  security: {
    webhookSecretConfigured: boolean;
    adminApiKeyConfigured: boolean;
    rateLimitMaxRequests: number;
    rateLimitWindowMs: number;
    maxHistoryMessages: number;
    maxContextChars: number;
  };
}

interface ProbeEntry {
  prompt: string;
  reply: string;
  modelUsed: string;
  latencyMs: number;
  contextTurnsUsed: number;
  usedFallbackModel: boolean;
}

export function NexaConsole() {
  const [status, setStatus] = useState<BotStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [probingGemini, setProbingGemini] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [webhookInput, setWebhookInput] = useState("");

  // Real end-to-end diagnostic probe state
  const [probePrompt, setProbePrompt] = useState("");
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeHistory, setProbeHistory] = useState<ProbeEntry[]>([]);

  const fetchStatus = useCallback(async (probeGemini = false) => {
    if (probeGemini) setProbingGemini(true);
    try {
      const res = await fetch(
        `/api/bot/status${probeGemini ? "?probeGemini=true" : ""}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as BotStatusPayload;
      setStatus(data);
    } catch {
      setNotice({ type: "err", text: "Unable to load live system status." });
    } finally {
      setLoading(false);
      setProbingGemini(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus(false);
  }, [fetchStatus]);

  async function runControlAction(
    action: "start_polling" | "stop_polling" | "sync_profile" | "set_webhook" | "delete_webhook",
    extra?: Record<string, string>
  ) {
    setActionBusy(action);
    setNotice(null);
    try {
      const res = await fetch("/api/bot/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({
          type: "err",
          text: data.error || `Action "${action}" did not complete cleanly.`,
        });
      } else {
        const successMessages: Record<typeof action, string> = {
          start_polling: "Telegram long-polling is now LIVE and listening for user messages.",
          stop_polling: "Telegram long-polling stopped.",
          sync_profile:
            "Synced NEXA AI display name, about, description, commands, and menu button to Telegram.",
          set_webhook: `Production webhook configured: ${data.webhookUrl}`,
          delete_webhook: "Telegram webhook removed.",
        };
        setNotice({ type: "ok", text: successMessages[action] });
      }
      await fetchStatus(false);
    } catch {
      setNotice({ type: "err", text: `Failed to execute ${action}.` });
    } finally {
      setActionBusy(null);
    }
  }

  async function runLiveProbe(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = probePrompt.trim();
    if (!trimmed || probeBusy) return;

    setProbeBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/bot/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", message: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ type: "err", text: data.error || "Live Gemini probe failed." });
      } else {
        setProbeHistory((prev) => [
          ...prev,
          {
            prompt: trimmed,
            reply: data.reply,
            modelUsed: data.modelUsed,
            latencyMs: data.latencyMs,
            contextTurnsUsed: data.contextTurnsUsed,
            usedFallbackModel: Boolean(data.usedFallbackModel),
          },
        ]);
        setProbePrompt("");
        void fetchStatus(false);
      }
    } catch {
      setNotice({ type: "err", text: "Network error during live Gemini probe." });
    } finally {
      setProbeBusy(false);
    }
  }

  async function resetLiveProbeMemory() {
    setProbeBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/bot/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setProbeHistory([]);
        setNotice({
          type: "ok",
          text: `Diagnostic conversation reset in PostgreSQL (${data.previousCount ?? 0} messages cleared).`,
        });
        void fetchStatus(false);
      }
    } finally {
      setProbeBusy(false);
    }
  }

  const botUsername = status?.telegram.bot?.username;
  const botDeepLink = status?.telegram.bot?.deepLink;
  const pollingActive = status?.telegram.runtime.pollingActive ?? false;
  const activeWebhookUrl = status?.telegram.webhook?.url ?? "";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Top Brand & Live Bot Header */}
      <header className="mb-8 flex flex-col gap-5 rounded-2xl border border-slate-800/80 bg-slate-950/75 p-6 shadow-2xl shadow-cyan-950/20 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl ring-1 ring-cyan-400/40 shadow-lg shadow-cyan-500/20">
            <img
              src="/assets/nexa-ai-avatar.png"
              alt="NEXA AI Official Circular Avatar"
              className="h-full w-full object-cover"
            />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight text-white">
                NEXA AI
              </h1>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-medium text-cyan-300">
                <Sparkles className="h-3 w-3" />
                Production Telegram AI Bot
              </span>
              {status && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    status.ok
                      ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border border-amber-500/30 bg-amber-500/10 text-amber-300"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      status.ok ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                    }`}
                  />
                  {pollingActive
                    ? "Live Polling Active"
                    : activeWebhookUrl
                      ? "Webhook Configured"
                      : "Bot Connected"}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Real Telegram Bot API (<span className="text-slate-200 font-mono">telegraf</span>) + Google Gemini (<span className="text-slate-200 font-mono">@google/genai</span>) + PostgreSQL persistent memory.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {botDeepLink && (
            <a
              href={botDeepLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 transition hover:brightness-110"
            >
              <Bot className="h-4 w-4" />
              Open @{botUsername} in Telegram
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => void fetchStatus(true)}
            disabled={probingGemini}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${probingGemini ? "animate-spin" : ""}`} />
            {probingGemini ? "Probing APIs..." : "Verify Live APIs"}
          </button>
        </div>
      </header>

      {notice && (
        <div
          className={`mb-6 flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${
            notice.type === "ok"
              ? "border-emerald-500/30 bg-emerald-950/40 text-emerald-200"
              : "border-rose-500/30 bg-rose-950/40 text-rose-200"
          }`}
        >
          <div className="flex items-center gap-2.5">
            {notice.type === "ok" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            )}
            <span>{notice.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Live Infrastructure Cards */}
      <section className="mb-8 grid gap-4 md:grid-cols-3">
        {/* Telegram Card */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Bot className="h-4 w-4 text-cyan-400" />
              Telegram Bot API
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                status?.telegram.ok
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-amber-500/15 text-amber-300"
              }`}
            >
              {loading ? "Checking..." : status?.telegram.ok ? "Connected" : "Offline"}
            </span>
          </div>
          <dl className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Bot Handle</dt>
              <dd className="font-mono text-slate-100">
                {botUsername ? `@${botUsername}` : "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Delivery Mode</dt>
              <dd className="font-mono text-cyan-300">
                {pollingActive
                  ? "long-polling (active)"
                  : activeWebhookUrl
                    ? "webhook (production)"
                    : status?.telegram.runtime.mode ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Pending Updates</dt>
              <dd className="font-mono text-slate-200">
                {status?.telegram.webhook?.pendingUpdateCount ?? 0}
              </dd>
            </div>
          </dl>
        </div>

        {/* Gemini Card */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Cpu className="h-4 w-4 text-indigo-400" />
              Google Gemini Engine
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                status?.gemini.ok
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-amber-500/15 text-amber-300"
              }`}
            >
              {loading
                ? "Checking..."
                : status?.gemini.probed
                  ? status.gemini.ok
                    ? `Verified (${status.gemini.latencyMs}ms)`
                    : "Degraded"
                  : status?.gemini.configured
                    ? "Configured"
                    : "Missing Key"}
            </span>
          </div>
          <dl className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Primary Model</dt>
              <dd className="font-mono text-slate-100">
                {status?.gemini.configuredModel ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Fallback Chain</dt>
              <dd className="truncate pl-4 font-mono text-slate-300">
                {status?.gemini.fallbackModels.join(", ") || "None"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Context Budget</dt>
              <dd className="font-mono text-slate-200">
                {status?.security.maxHistoryMessages ?? 20} msgs /{" "}
                {Math.round((status?.security.maxContextChars ?? 24000) / 1000)}k chars
              </dd>
            </div>
          </dl>
        </div>

        {/* PostgreSQL Card */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Database className="h-4 w-4 text-emerald-400" />
              PostgreSQL Memory
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                status?.database.ok
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-rose-500/15 text-rose-300"
              }`}
            >
              {loading
                ? "Checking..."
                : status?.database.ok
                  ? `Connected (${status.database.latencyMs}ms)`
                  : "Error"}
            </span>
          </div>
          <dl className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Telegram Users</dt>
              <dd className="font-mono text-slate-100">
                {status?.database.stats.totalUsers ?? 0}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Active Conversations</dt>
              <dd className="font-mono text-slate-100">
                {status?.database.stats.activeConversations ?? 0}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Persisted Messages</dt>
              <dd className="font-mono text-cyan-300">
                {status?.database.stats.totalMessages ?? 0}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Main 2-Column Operations Grid */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Column: Telegram Profile Identity & BotFather Configuration */}
        <section className="space-y-6 lg:col-span-5">
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/75 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                Telegram Bot Profile Identity
              </h2>
              <span className="text-xs text-slate-500">1024 × 1024 Asset</span>
            </div>

            {/* Authentic Telegram Bot Profile Preview Card */}
            <div className="rounded-2xl border border-slate-800 bg-[#0d1424] p-5">
              <div className="flex flex-col items-center text-center">
                <div className="h-40 w-40 overflow-hidden rounded-2xl ring-1 ring-cyan-400/50 shadow-xl shadow-cyan-500/20">
                  <img
                    src="/assets/nexa-ai-avatar.png"
                    alt="NEXA AI 1024x1024 Telegram Avatar"
                    className="h-full w-full object-cover"
                  />
                </div>
                <h3 className="mt-3 text-lg font-bold text-white">NEXA AI</h3>
                <p className="font-mono text-xs text-cyan-400">
                  {botUsername ? `@${botUsername}` : "@NexaGenius_Bot"} · bot
                </p>
                <p className="mt-2 rounded-lg bg-slate-900/90 px-3 py-1 text-xs text-slate-300">
                  About: <span className="text-white">Ask me anything.</span>
                </p>
              </div>

              <div className="mt-4 rounded-xl border border-slate-800/90 bg-slate-950/80 p-3.5 text-left">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                  What can this bot do?
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">
                  Your intelligent AI assistant. Ask questions, explore ideas,
                  solve problems, learn new things and get assistance whenever
                  you need it.
                </p>
              </div>

              {/* Inline Keyboard Preview */}
              <div className="mt-3 grid grid-cols-2 gap-1.5 text-center text-[11px] font-medium text-cyan-200">
                <div className="rounded-lg bg-slate-800/80 py-2">Start Chatting</div>
                <div className="rounded-lg bg-slate-800/80 py-2">About NEXA AI</div>
                <div className="rounded-lg bg-slate-800/80 py-2">Help &amp; Commands</div>
                <div className="rounded-lg bg-slate-800/80 py-2">Reset Conversation</div>
              </div>
            </div>

            {/* Avatar Download + API Sync Actions */}
            <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
              <a
                href="/assets/nexa-ai-avatar.png"
                download="nexa-ai-avatar-1024x1024.png"
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs font-semibold text-slate-100 transition hover:border-cyan-500/50 hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5 text-cyan-400" />
                Download 1024×1024 PNG
              </a>
              <button
                type="button"
                onClick={() => void runControlAction("sync_profile")}
                disabled={actionBusy !== null}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500/15 px-3.5 py-2.5 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-500/35 transition hover:bg-cyan-500/25 disabled:opacity-50"
              >
                <Activity className="h-3.5 w-3.5" />
                {actionBusy === "sync_profile" ? "Syncing..." : "Sync Bot API Profile"}
              </button>
            </div>

            {/* BotFather vs API Matrix */}
            <div className="mt-5 rounded-xl border border-slate-800/90 bg-slate-900/40 p-4">
              <h4 className="text-xs font-semibold text-slate-200">
                BotFather vs. Automated Bot API Setup
              </h4>
              <ul className="mt-2.5 space-y-1.5 text-xs text-slate-400">
                <li className="flex items-start justify-between gap-2">
                  <span>Display Name, About, Description, Commands, Menu</span>
                  <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                    Automated via API
                  </span>
                </li>
                <li className="flex items-start justify-between gap-2">
                  <span>Bot Username &amp; Token</span>
                  <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                    @BotFather /newbot
                  </span>
                </li>
                <li className="flex items-start justify-between gap-2">
                  <span>Profile Picture (1024×1024 PNG)</span>
                  <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                    @BotFather /setuserpic
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Right Column: Live Bot Controls + Real End-to-End Gemini/DB Probe */}
        <section className="space-y-6 lg:col-span-7">
          {/* Runtime Delivery Controls */}
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/75 p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                Telegram Delivery &amp; Security Controls
              </h2>
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
                <ShieldCheck className="h-3.5 w-3.5" />
                {status?.security.webhookSecretConfigured
                  ? "Webhook Secret Active"
                  : "Set WEBHOOK_SECRET for Prod"}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void runControlAction("start_polling")}
                disabled={actionBusy !== null || pollingActive}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500/15 px-4 py-2.5 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-500/35 transition hover:bg-emerald-500/25 disabled:opacity-45"
              >
                <Play className="h-3.5 w-3.5" />
                {pollingActive
                  ? "Long-Polling Running"
                  : actionBusy === "start_polling"
                    ? "Starting..."
                    : "Start Long-Polling (Dev/Live)"}
              </button>

              <button
                type="button"
                onClick={() => void runControlAction("stop_polling")}
                disabled={actionBusy !== null || !pollingActive}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-45"
              >
                <Square className="h-3.5 w-3.5" />
                {actionBusy === "stop_polling" ? "Stopping..." : "Stop Long-Polling"}
              </button>
            </div>

            {/* Production Webhook Configurator */}
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-slate-200">
                  <Globe className="h-3.5 w-3.5 text-cyan-400" />
                  Production HTTPS Webhook
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  POST /api/telegram/webhook
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Active webhook:{" "}
                <span className="font-mono text-slate-200">
                  {activeWebhookUrl || "None (using long polling)"}
                </span>
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={webhookInput}
                  onChange={(e) => setWebhookInput(e.target.value)}
                  placeholder="https://your-nexa-ai-domain.onrender.com"
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    void runControlAction("set_webhook", { webhookUrl: webhookInput })
                  }
                  disabled={!webhookInput.startsWith("https://") || actionBusy !== null}
                  className="rounded-xl bg-cyan-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-cyan-500 disabled:opacity-40"
                >
                  Set Webhook
                </button>
                {activeWebhookUrl && (
                  <button
                    type="button"
                    onClick={() => void runControlAction("delete_webhook")}
                    disabled={actionBusy !== null}
                    className="inline-flex items-center justify-center gap-1 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/20"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Real Live Gemini + PostgreSQL Diagnostic Probe */}
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/75 p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
                  <Terminal className="h-4 w-4 text-cyan-400" />
                  Live Gemini + PostgreSQL Pipeline Probe
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  Executes the real backend AI + memory pipeline against Google Gemini and PostgreSQL (never simulated).
                </p>
              </div>
              <button
                type="button"
                onClick={() => void resetLiveProbeMemory()}
                disabled={probeBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                Reset Probe Memory
              </button>
            </div>

            {probeHistory.length > 0 && (
              <div className="mt-4 max-h-64 space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/60 p-3.5">
                {probeHistory.map((item, index) => (
                  <div key={index} className="space-y-1.5 border-b border-slate-800/80 pb-3 last:border-0 last:pb-0">
                    <div className="text-xs font-medium text-cyan-300">
                      Prompt: <span className="text-slate-100">{item.prompt}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                      {item.reply}
                    </div>
                    <div className="flex flex-wrap gap-3 pt-1 font-mono text-[10px] text-slate-500">
                      <span>model: {item.modelUsed}</span>
                      <span>latency: {item.latencyMs}ms</span>
                      <span>memory turns: {item.contextTurnsUsed}</span>
                      {item.usedFallbackModel && (
                        <span className="text-amber-400">fallback used</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={runLiveProbe} className="mt-4 flex gap-2">
              <input
                type="text"
                value={probePrompt}
                onChange={(e) => setProbePrompt(e.target.value)}
                placeholder="Send a live verification prompt (e.g. 'My favorite language is Rust' then follow up)..."
                className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={probeBusy || !probePrompt.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-45"
              >
                <Send className="h-3.5 w-3.5" />
                {probeBusy ? "Running..." : "Run Probe"}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
