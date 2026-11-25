import crypto from "crypto";
import { logger, redactString } from "@/utils/logger";

export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "GEMINI_UNAVAILABLE"
  | "GEMINI_QUOTA"
  | "GEMINI_AUTH"
  | "GEMINI_SAFETY"
  | "DATABASE_ERROR"
  | "TELEGRAM_ERROR"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export class NexaError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(params: {
    code: AppErrorCode;
    message: string;
    userMessage: string;
    statusCode?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "NexaError";
    this.code = params.code;
    this.userMessage = params.userMessage;
    this.statusCode = params.statusCode ?? 500;
    this.retryable = params.retryable ?? false;
  }
}

export function classifyError(error: unknown): NexaError {
  if (error instanceof NexaError) {
    return error;
  }

  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes("503") ||
    lower.includes("unavailable") ||
    lower.includes("high demand") ||
    lower.includes("overloaded") ||
    lower.includes("timeout")
  ) {
    return new NexaError({
      code: "GEMINI_UNAVAILABLE",
      message: redactString(rawMessage),
      userMessage:
        "NEXA AI's intelligence engine is experiencing brief high demand. Please send your message again in a few seconds.",
      statusCode: 503,
      retryable: true,
      cause: error,
    });
  }

  if (lower.includes("429") || lower.includes("quota") || lower.includes("resource_exhausted")) {
    return new NexaError({
      code: "GEMINI_QUOTA",
      message: redactString(rawMessage),
      userMessage:
        "I'm temporarily busy handling many requests right now. Please try again in a moment.",
      statusCode: 429,
      retryable: true,
      cause: error,
    });
  }

  if (lower.includes("api key") || lower.includes("api_key_invalid") || lower.includes("401")) {
    return new NexaError({
      code: "GEMINI_AUTH",
      message: redactString(rawMessage),
      userMessage:
        "NEXA AI is currently undergoing maintenance. Please try again shortly.",
      statusCode: 502,
      retryable: false,
      cause: error,
    });
  }

  if (lower.includes("safety") || lower.includes("blocked")) {
    return new NexaError({
      code: "GEMINI_SAFETY",
      message: redactString(rawMessage),
      userMessage:
        "I wasn't able to generate a response for that request. Try rephrasing your question and I'll be glad to help.",
      statusCode: 400,
      retryable: false,
      cause: error,
    });
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("postgres") ||
    lower.includes("database") ||
    lower.includes("drizzle") ||
    lower.includes("relation")
  ) {
    return new NexaError({
      code: "DATABASE_ERROR",
      message: redactString(rawMessage),
      userMessage:
        "I ran into a temporary memory storage issue. Please try again in a moment.",
      statusCode: 503,
      retryable: true,
      cause: error,
    });
  }

  return new NexaError({
    code: "INTERNAL_ERROR",
    message: redactString(rawMessage),
    userMessage:
      "Something unexpected happened while preparing your response. Please try again.",
    statusCode: 500,
    retryable: true,
    cause: error,
  });
}

export function getSafeUserErrorMessage(error: unknown): string {
  const classified = classifyError(error);
  logger.error("Handled runtime error", {
    code: classified.code,
    message: classified.message,
  });
  return classified.userMessage;
}

export function verifyConstantTimeSecret(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const MAX_MESSAGE_LENGTH = 8000;

export function sanitizeUserMessage(raw: string): { valid: true; text: string } | { valid: false; reason: string } {
  // Strip null bytes and dangerous control characters while keeping newlines & tabs
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

  if (cleaned.length === 0) {
    return {
      valid: false,
      reason: "Please send a text message or question so I can help you.",
    };
  }

  if (cleaned.length > MAX_MESSAGE_LENGTH) {
    return {
      valid: false,
      reason: `Your message is a bit too long (${cleaned.length} characters). Please keep messages under ${MAX_MESSAGE_LENGTH} characters or split it into smaller parts.`,
    };
  }

  return { valid: true, text: cleaned };
}
