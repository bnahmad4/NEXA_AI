import { describe, expect, it } from "vitest";
import { buildGeminiContextWindow } from "@/ai/conversation";
import {
  classifyError,
  sanitizeUserMessage,
  verifyConstantTimeSecret,
} from "@/middleware/error-handler";
import { SlidingWindowRateLimiter } from "@/middleware/rate-limit";
import {
  formatForTelegramChunks,
  markdownToTelegramHtml,
} from "@/telegram/format";
import { redactString } from "@/utils/logger";

describe("Telegram HTML Formatting & Long Message Chunking", () => {
  it("escapes HTML entities while preserving markdown bold, italic, inline code, and fenced blocks", () => {
    const input = [
      "# Overview",
      "Use **TypeScript** with `Array<string>` and check `a < b && c > d`.",
      "",
      "```ts",
      "const fn = (x: Array<number>) => x.length > 0 && x[0] < 10;",
      "```",
    ].join("\n");

    const html = markdownToTelegramHtml(input);
    expect(html).toContain("<b>Overview</b>");
    expect(html).toContain("<b>TypeScript</b>");
    expect(html).toContain("<code>Array&lt;string&gt;</code>");
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("Array&lt;number&gt;");
    expect(html).not.toContain("<number>");
  });

  it("chunks long messages safely under Telegram's 4096 character limit while preserving code fences", () => {
    const longCodeLines = Array.from({ length: 180 }, (_, i) => `console.log("line_${i}_" + "x".repeat(25));`).join("\n");
    const longMarkdown = `Here is a large script:\n\n\`\`\`js\n${longCodeLines}\n\`\`\`\n\nDone.`;

    const chunks = formatForTelegramChunks(longMarkdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(4096);
      expect(chunk.plain.length).toBeLessThanOrEqual(4096);
    }
    expect(chunks[0].html).toContain('<pre><code class="language-js">');
  });
});

describe("Conversation Context-Window Management", () => {
  it("enforces maxMessages and maxChars bounds and ensures alternating user/model turns", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message #${i}: ${"a".repeat(120)}`,
    }));

    const window = buildGeminiContextWindow({
      history,
      currentUserMessage: "Follow-up question",
      maxMessages: 6,
      maxChars: 2000,
    });

    expect(window.includedTurns).toBeLessThanOrEqual(6);
    expect(window.droppedTurns).toBeGreaterThan(0);
    expect(window.contents[0].role).toBe("user");
    expect(window.contents[window.contents.length - 1].role).toBe("user");
    expect(window.contents[window.contents.length - 1].parts[0].text).toContain("Follow-up question");

    // Verify strict alternation
    for (let i = 1; i < window.contents.length; i++) {
      expect(window.contents[i].role).not.toBe(window.contents[i - 1].role);
    }
  });
});

describe("Rate Limiting & Abuse Protection", () => {
  it("allows normal traffic, blocks burst and window excess, and recovers after window", () => {
    const limiter = new SlidingWindowRateLimiter({
      maxRequests: 4,
      windowMs: 10000,
      burstLimit: 3,
      burstWindowMs: 2000,
    });

    const t0 = 100000;
    expect(limiter.check("user_1", t0).allowed).toBe(true);
    expect(limiter.check("user_1", t0 + 100).allowed).toBe(true);
    expect(limiter.check("user_1", t0 + 200).allowed).toBe(true);
    // 4th request inside 2s burst window should be blocked
    const burstBlocked = limiter.check("user_1", t0 + 300);
    expect(burstBlocked.allowed).toBe(false);
    expect(burstBlocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // After burst window passes (t0 + 2500), 4th request in 10s window succeeds
    expect(limiter.check("user_1", t0 + 2500).allowed).toBe(true);
    // 5th request inside 10s window is blocked
    expect(limiter.check("user_1", t0 + 3000).allowed).toBe(false);

    // Different user is completely unaffected
    expect(limiter.check("user_2", t0 + 3000).allowed).toBe(true);

    // After 10s window expires, user_1 recovers
    expect(limiter.check("user_1", t0 + 13000).allowed).toBe(true);
  });
});

describe("Security: Input Validation, Secret Redaction & Webhook Auth", () => {
  it("sanitizes control characters and rejects empty or oversized messages", () => {
    expect(sanitizeUserMessage("   \n\t  ").valid).toBe(false);
    expect(sanitizeUserMessage("x".repeat(8500)).valid).toBe(false);

    const cleaned = sanitizeUserMessage("Hello\u0000 NEXA\u0007 AI\nLine 2");
    expect(cleaned.valid).toBe(true);
    if (cleaned.valid) {
      expect(cleaned.text).toBe("Hello NEXA AI\nLine 2");
    }
  });

  it("redacts tokens and API keys from logs and errors", () => {
    const leaky =
      "Error using token 1234567890:AAH1234567890abcdefghijklmnopqrstuv and key AQ.DummySyntheticKey1234567890abcdefghijklmnopqrstuv";
    const redacted = redactString(leaky);
    expect(redacted).not.toContain("1234567890:AAH");
    expect(redacted).not.toContain("AQ.DummySynthetic");
    expect(redacted).toContain("[REDACTED]");
  });

  it("maps upstream Gemini 503 and DB failures into safe non-leaking user messages", () => {
    const gemini503 = classifyError(new Error("503 UNAVAILABLE: high demand on backend"));
    expect(gemini503.code).toBe("GEMINI_UNAVAILABLE");
    expect(gemini503.userMessage).not.toContain("503");

    const dbFail = classifyError(new Error("ECONNREFUSED postgresql://postgres:secret@127.0.0.1/app_db"));
    expect(dbFail.code).toBe("DATABASE_ERROR");
    expect(dbFail.userMessage).not.toContain("postgres");
    expect(dbFail.message).not.toContain("secret");
  });

  it("validates webhook secrets using constant-time comparison", () => {
    expect(verifyConstantTimeSecret("my_secret_123", "my_secret_123")).toBe(true);
    expect(verifyConstantTimeSecret("my_secret_124", "my_secret_123")).toBe(false);
    expect(verifyConstantTimeSecret("short", "my_secret_123")).toBe(false);
    expect(verifyConstantTimeSecret(null, "my_secret_123")).toBe(false);
  });
});
