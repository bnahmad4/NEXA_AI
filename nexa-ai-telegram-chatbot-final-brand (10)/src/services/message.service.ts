import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  conversations,
  messages,
  processedUpdates,
  type MessageMetadata,
  type MessageRow,
} from "@/db/schema";

export interface SaveMessageInput {
  conversationId: number;
  userId: number;
  role: "user" | "assistant" | "system";
  content: string;
  telegramMessageId?: string | number | null;
  contentType?: "text" | "image" | "document" | "voice";
  metadata?: MessageMetadata;
  modelUsed?: string | null;
  latencyMs?: number | null;
}

export async function saveMessage(input: SaveMessageInput): Promise<MessageRow> {
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      telegramMessageId:
        input.telegramMessageId !== undefined && input.telegramMessageId !== null
          ? String(input.telegramMessageId)
          : null,
      contentType: input.contentType ?? "text",
      metadata: input.metadata ?? { phase: 1 },
      modelUsed: input.modelUsed ?? null,
      latencyMs: input.latencyMs ?? null,
    })
    .returning();

  // Keep conversation message count & updated timestamp in sync
  await db
    .update(conversations)
    .set({
      messageCount: sql`${conversations.messageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.userId)
      )
    );

  return inserted;
}

/**
 * Retrieves the most recent messages for a specific conversation strictly scoped
 * to the owning user, returned in chronological order (oldest -> newest).
 */
export async function getRecentConversationMessages(
  conversationId: number,
  userId: number,
  limit = 20
): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.userId, userId)
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);

  return rows.reverse();
}

/**
 * Atomically records a Telegram update_id to prevent duplicate message processing
 * across webhook retries or restarts. Returns true if this is a NEW update,
 * or false if the update was already processed.
 */
export async function claimTelegramUpdate(
  updateId: number,
  telegramUserId?: string | number
): Promise<boolean> {
  const inserted = await db
    .insert(processedUpdates)
    .values({
      updateId,
      telegramUserId:
        telegramUserId !== undefined ? String(telegramUserId) : null,
    })
    .onConflictDoNothing({ target: processedUpdates.updateId })
    .returning({ updateId: processedUpdates.updateId });

  return inserted.length > 0;
}

/**
 * Data retention helper: prunes deduplication markers older than `retentionDays`.
 */
export async function pruneOldProcessedUpdates(retentionDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(processedUpdates)
    .where(lt(processedUpdates.processedAt, cutoff))
    .returning({ updateId: processedUpdates.updateId });

  return deleted.length;
}
