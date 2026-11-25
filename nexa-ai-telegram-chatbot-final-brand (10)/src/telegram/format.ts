const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const SAFE_CHUNK_LIMIT = 3600;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converts standard Gemini Markdown into Telegram-compatible HTML safely.
 * Preserves fenced code blocks and inline code without double-escaping or
 * breaking Telegram's strict HTML subset.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks first so inner markdown/HTML isn't touched
  let text = markdown.replace(
    /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const idx = codeBlocks.length;
      const safeLang = lang.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
      const safeCode = escapeHtml(code.replace(/\n$/, ""));
      const html = safeLang
        ? `<pre><code class="language-${safeLang}">${safeCode}</code></pre>`
        : `<pre><code>${safeCode}</code></pre>`;
      codeBlocks.push(html);
      return `@@NEXA_CODE_BLOCK_${idx}@@`;
    }
  );

  // 2. Extract inline code spans
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `@@NEXA_INLINE_CODE_${idx}@@`;
  });

  // 3. Escape remaining raw HTML entities
  text = escapeHtml(text);

  // 4. Headings -> Bold section titles with clean spacing
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 5. Links [label](https://...)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // 6. Bold **text** and __text__
  text = text.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([\s\S]+?)__/g, "<b>$1</b>");

  // 7. Italic *text* (avoid matching bullet lists at line start)
  text = text.replace(/(^|[^\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?!\*)/gm, "$1<i>$2</i>");

  // 8. Strikethrough ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  // 9. Clean unordered list bullets
  text = text.replace(/^[ \t]*[-*]\s+/gm, "• ");

  // 10. Restore inline code and fenced code blocks
  text = text.replace(/@@NEXA_INLINE_CODE_(\d+)@@/g, (_m, i) => inlineCodes[Number(i)] ?? "");
  text = text.replace(/@@NEXA_CODE_BLOCK_(\d+)@@/g, (_m, i) => codeBlocks[Number(i)] ?? "");

  return text.trim();
}

/**
 * Splits a long raw Markdown response into chunks that stay safely below Telegram's
 * 4096-character limit even after HTML escaping, while preserving fenced code blocks.
 */
export function splitLongMarkdown(raw: string, maxChunkLength = SAFE_CHUNK_LIMIT): string[] {
  const trimmed = raw.trim();
  if (trimmed.length <= maxChunkLength) {
    return [trimmed];
  }

  const lines = trimmed.split("\n");
  const chunks: string[] = [];
  let current = "";
  let inCodeFence = false;
  let currentFenceHeader = "```";

  for (const line of lines) {
    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)/);

    const addition = current.length === 0 ? line : `\n${line}`;
    // Leave margin for closing/reopening code fences if needed
    const effectiveLimit = inCodeFence ? maxChunkLength - 16 : maxChunkLength;

    if (current.length + addition.length > effectiveLimit && current.length > 0) {
      if (inCodeFence) {
        chunks.push(`${current}\n\`\`\``);
        current = `${currentFenceHeader}\n${line}`;
      } else {
        chunks.push(current.trim());
        current = line;
      }
    } else {
      current += addition;
    }

    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true;
        currentFenceHeader = fenceMatch[0] || "```";
      } else {
        inCodeFence = false;
        currentFenceHeader = "```";
      }
    }

    // Hard split if a single line itself exceeds maxChunkLength
    while (current.length > maxChunkLength) {
      chunks.push(current.slice(0, maxChunkLength));
      current = current.slice(maxChunkLength);
    }
  }

  if (current.trim().length > 0) {
    chunks.push(inCodeFence ? `${current}\n\`\`\`` : current.trim());
  }

  return chunks;
}

export function formatForTelegramChunks(rawMarkdown: string): Array<{
  html: string;
  plain: string;
}> {
  const mdChunks = splitLongMarkdown(rawMarkdown);
  const result: Array<{ html: string; plain: string }> = [];

  for (const chunk of mdChunks) {
    const html = markdownToTelegramHtml(chunk);
    if (html.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      result.push({ html, plain: chunk });
    } else {
      // Secondary split if HTML expansion pushed a chunk over 4096 chars
      const smallerChunks = splitLongMarkdown(chunk, 2400);
      for (const sub of smallerChunks) {
        result.push({
          html: markdownToTelegramHtml(sub).slice(0, TELEGRAM_MAX_MESSAGE_LENGTH),
          plain: sub.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH),
        });
      }
    }
  }

  return result;
}
