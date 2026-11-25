import { getSecretValuesForRedaction } from "@/config/env";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /(token|api[_-]?key|secret|password|authorization|cookie|credential|database_url)/i;

const TOKEN_VALUE_PATTERNS: RegExp[] = [
  /\b\d{8,12}:[A-Za-z0-9_-]{30,50}\b/g, // Telegram bot tokens
  /\bAIza[0-9A-Za-z_-]{30,45}\b/g, // Google API keys
  /\bAQ\.[A-Za-z0-9._-]{20,80}\b/g, // Google GenAI / Vertex Express keys
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /postgresql:\/\/[^@\s]+@/gi,
];

export function redactString(input: string): string {
  let output = input;

  try {
    for (const secret of getSecretValuesForRedaction()) {
      if (secret && output.includes(secret)) {
        output = output.split(secret).join("[REDACTED]");
      }
    }
  } catch {
    // Ignore env errors during early logging
  }

  for (const pattern of TOKEN_VALUE_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }

  return output;
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MaxDepth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack:
        process.env.NODE_ENV === "development" && value.stack
          ? redactString(value.stack)
          : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        clean[k] = "[REDACTED]";
      } else {
        clean[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return clean;
  }
  return String(value);
}

function getMinLevel(): LogLevel {
  if (process.env.NODE_ENV === "test") return "error";
  if (process.env.NODE_ENV === "production") return "info";
  return "debug";
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[getMinLevel()]) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "nexa-ai",
    message: redactString(message),
    ...(meta ? { meta: sanitizeLogValue(meta) } : {}),
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
