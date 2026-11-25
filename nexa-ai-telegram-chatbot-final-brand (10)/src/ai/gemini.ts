import { GoogleGenAI } from "@google/genai";
import { getEnv, isGeminiConfigured } from "@/config/env";
import {
  buildSystemInstruction,
  type AgentToolDefinition,
  type MultimodalAttachment,
} from "@/ai/prompts";
import { buildGeminiContextWindow, type StoredTurn } from "@/ai/conversation";
import { classifyError, NexaError } from "@/middleware/error-handler";
import { logger } from "@/utils/logger";

export interface GenerateReplyInput {
  history: StoredTurn[];
  userMessage: string;
  userName?: string | null;
  modelOverride?: string | null;
  temperature?: number;
  responseStyle?: string;
  maxHistoryMessages?: number;
}

export interface GenerateReplyResult {
  text: string;
  modelUsed: string;
  latencyMs: number;
  contextTurnsUsed: number;
  droppedTurns: number;
  usedFallbackModel: boolean;
}

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey = "";

// Phase 3 registry hook for future tool/function calling
const registeredTools = new Map<string, AgentToolDefinition>();

export function registerAgentTool(tool: AgentToolDefinition): void {
  registeredTools.set(tool.name, tool);
}

export function getRegisteredAgentTools(): AgentToolDefinition[] {
  return Array.from(registeredTools.values());
}

function getGeminiClient(): GoogleGenAI {
  const env = getEnv();
  if (!isGeminiConfigured()) {
    throw new NexaError({
      code: "GEMINI_AUTH",
      message: "GEMINI_API_KEY is not configured",
      userMessage: "NEXA AI is not yet connected to its AI engine. Please contact the administrator.",
      statusCode: 503,
    });
  }

  if (!cachedClient || cachedApiKey !== env.GEMINI_API_KEY) {
    cachedClient = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    cachedApiKey = env.GEMINI_API_KEY;
  }

  return cachedClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTransientStatusError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = (error as { status?: number })?.status;
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("timeout") ||
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("resource_exhausted")
  );
}

export async function generateNexaReply(
  input: GenerateReplyInput
): Promise<GenerateReplyResult> {
  const env = getEnv();
  const client = getGeminiClient();
  const started = Date.now();

  const primaryModel = input.modelOverride?.trim() || env.GEMINI_MODEL;
  const candidateModels = [
    primaryModel,
    ...env.fallbackModels.filter((m) => m !== primaryModel),
  ];

  const contextWindow = buildGeminiContextWindow({
    history: input.history,
    currentUserMessage: input.userMessage,
    maxMessages: input.maxHistoryMessages ?? env.MAX_HISTORY_MESSAGES,
    maxChars: env.MAX_CONTEXT_CHARS,
  });

  const systemInstruction = buildSystemInstruction({
    responseStyle: input.responseStyle,
    userName: input.userName,
  });

  let lastError: unknown;

  for (let idx = 0; idx < candidateModels.length; idx++) {
    const model = candidateModels[idx];

    // Up to 2 attempts per model for transient spikes
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await withTimeout(
          client.models.generateContent({
            model,
            contents: contextWindow.contents,
            config: {
              systemInstruction,
              temperature: input.temperature ?? 0.7,
              maxOutputTokens: 2048,
            },
          }),
          18000,
          `gemini:${model}`
        );

        const text = response.text?.trim();
        if (!text) {
          throw new NexaError({
            code: "GEMINI_SAFETY",
            message: `Empty response returned from Gemini model ${model}`,
            userMessage:
              "I couldn't produce an answer for that message. Could you try phrasing it a slightly different way?",
            statusCode: 400,
          });
        }

        const latencyMs = Date.now() - started;
        if (idx > 0) {
          logger.warn("Gemini primary model unavailable; succeeded with fallback", {
            primaryModel,
            fallbackModel: model,
            latencyMs,
          });
        }

        return {
          text,
          modelUsed: model,
          latencyMs,
          contextTurnsUsed: contextWindow.includedTurns,
          droppedTurns: contextWindow.droppedTurns,
          usedFallbackModel: idx > 0,
        };
      } catch (err) {
        lastError = err;
        const transient = isTransientStatusError(err);

        logger.warn("Gemini generation attempt failed", {
          model,
          attempt,
          transient,
          error: err instanceof Error ? err.message : String(err),
        });

        if (transient && attempt < 2) {
          await sleep(450 * attempt);
          continue;
        }

        // If transient error and another fallback model exists, try next model
        if (transient && idx < candidateModels.length - 1) {
          break;
        }

        // Non-transient error (e.g. auth or safety) -> stop immediately
        if (!transient) {
          throw classifyError(err);
        }
      }
    }
  }

  throw classifyError(lastError);
}

/**
 * Phase 2 Architectural Placeholder (explicitly honest — does not fake multimodal processing).
 */
export async function analyzeMultimodalAttachment(
  _attachment: MultimodalAttachment
): Promise<never> {
  throw new NexaError({
    code: "VALIDATION_ERROR",
    message: "Phase 2 multimodal analysis is not yet enabled",
    userMessage:
      "NEXA AI currently supports text conversations (Phase 1). Image, document, and voice understanding are architected for Phase 2 and coming soon!",
    statusCode: 501,
  });
}

export async function checkGeminiHealth(): Promise<{
  ok: boolean;
  configured: boolean;
  configuredModel: string;
  activeModel?: string;
  latencyMs: number;
  error?: string;
}> {
  const env = getEnv();
  const started = Date.now();

  if (!isGeminiConfigured()) {
    return {
      ok: false,
      configured: false,
      configuredModel: env.GEMINI_MODEL,
      latencyMs: Date.now() - started,
      error: "GEMINI_API_KEY is missing",
    };
  }

  try {
    const client = getGeminiClient();
    const candidateModels = [env.GEMINI_MODEL, ...env.fallbackModels];

    for (const model of candidateModels) {
      try {
        const res = await withTimeout(
          client.models.generateContent({
            model,
            contents: "Reply with the single word: OK",
            config: { maxOutputTokens: 32, temperature: 0 },
          }),
          10000,
          `health:${model}`
        );
        if (res.text) {
          return {
            ok: true,
            configured: true,
            configuredModel: env.GEMINI_MODEL,
            activeModel: model,
            latencyMs: Date.now() - started,
          };
        }
      } catch (err) {
        if (!isTransientStatusError(err)) {
          throw err;
        }
      }
    }

    return {
      ok: false,
      configured: true,
      configuredModel: env.GEMINI_MODEL,
      latencyMs: Date.now() - started,
      error: "Gemini models temporarily experiencing high demand",
    };
  } catch (err) {
    const classified = classifyError(err);
    return {
      ok: false,
      configured: true,
      configuredModel: env.GEMINI_MODEL,
      latencyMs: Date.now() - started,
      error: classified.code,
    };
  }
}
