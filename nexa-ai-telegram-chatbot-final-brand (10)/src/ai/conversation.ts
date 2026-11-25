import { getEnv } from "@/config/env";

export interface StoredTurn {
  role: "user" | "assistant" | "system" | string;
  content: string;
}

export interface GeminiContentTurn {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

export interface BuiltContextWindow {
  contents: GeminiContentTurn[];
  includedTurns: number;
  droppedTurns: number;
  totalChars: number;
}

/**
 * Builds a bounded, Gemini-compliant conversation history window.
 *
 * Strategy:
 * 1. Keep only 'user' and 'assistant' turns with non-empty text.
 * 2. Walk backwards from newest to oldest, enforcing both maxMessages and maxChars.
 * 3. Merge consecutive same-role messages so Gemini always receives alternating turns.
 * 4. Ensure the history begins with a 'user' turn (Gemini requirement).
 * 5. Append the new incoming user message cleanly.
 */
export function buildGeminiContextWindow(params: {
  history: StoredTurn[];
  currentUserMessage: string;
  maxMessages?: number;
  maxChars?: number;
}): BuiltContextWindow {
  const env = getEnv();
  const maxMessages = params.maxMessages ?? env.MAX_HISTORY_MESSAGES;
  const maxChars = params.maxChars ?? env.MAX_CONTEXT_CHARS;

  const usableHistory = params.history.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0
  );

  // Reserve space for the current user message
  const currentChars = params.currentUserMessage.length;
  const historyCharBudget = Math.max(1000, maxChars - currentChars);

  const selected: Array<{ role: "user" | "model"; text: string }> = [];
  let charSum = 0;

  for (let i = usableHistory.length - 1; i >= 0; i--) {
    if (selected.length >= maxMessages) break;

    const item = usableHistory[i];
    const text = item.content.trim();
    if (charSum + text.length > historyCharBudget && selected.length > 0) {
      break;
    }

    selected.unshift({
      role: item.role === "assistant" ? "model" : "user",
      text,
    });
    charSum += text.length;
  }

  // Ensure sequence starts with a user turn
  while (selected.length > 0 && selected[0].role !== "user") {
    const removed = selected.shift();
    if (removed) charSum -= removed.text.length;
  }

  // Append current user message
  selected.push({
    role: "user",
    text: params.currentUserMessage.trim(),
  });

  // Merge any adjacent identical roles so turns strictly alternate user <-> model
  const normalized: GeminiContentTurn[] = [];
  for (const turn of selected) {
    const last = normalized[normalized.length - 1];
    if (last && last.role === turn.role) {
      last.parts[0].text = `${last.parts[0].text}\n\n${turn.text}`;
    } else {
      normalized.push({
        role: turn.role,
        parts: [{ text: turn.text }],
      });
    }
  }

  const totalChars = normalized.reduce((acc, t) => acc + t.parts[0].text.length, 0);
  const includedHistoryCount = Math.max(0, selected.length - 1);

  return {
    contents: normalized,
    includedTurns: includedHistoryCount,
    droppedTurns: Math.max(0, usableHistory.length - includedHistoryCount),
    totalChars,
  };
}
