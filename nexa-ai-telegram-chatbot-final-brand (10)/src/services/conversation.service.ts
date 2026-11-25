import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  conversations,
  type ConversationRow,
  type ConversationSettings,
} from "@/db/schema";

export async function getOrCreateActiveConversation(
  userId: number
): Promise<ConversationRow> {
  const [active] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.isActive, true)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (active) {
    return active;
  }

  const [created] = await db
    .insert(conversations)
    .values({
      userId,
      title: "NEXA AI Conversation",
      isActive: true,
      messageCount: 0,
      settings: {},
    })
    .returning();

  return created;
}

export async function getConversationForUser(
  conversationId: number,
  userId: number
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  return row ?? null;
}

export async function resetUserConversation(
  userId: number
): Promise<{ previousCount: number; activeConversation: ConversationRow }> {
  const now = new Date();

  const deactivated = await db
    .update(conversations)
    .set({
      isActive: false,
      resetAt: now,
      updatedAt: now,
    })
    .where(and(eq(conversations.userId, userId), eq(conversations.isActive, true)))
    .returning({ id: conversations.id, messageCount: conversations.messageCount });

  const previousCount = deactivated.reduce((sum, c) => sum + c.messageCount, 0);

  const [fresh] = await db
    .insert(conversations)
    .values({
      userId,
      title: "NEXA AI Conversation",
      isActive: true,
      messageCount: 0,
      settings: {},
    })
    .returning();

  return {
    previousCount,
    activeConversation: fresh,
  };
}

export async function updateConversationSettings(
  conversationId: number,
  userId: number,
  settings: ConversationSettings
): Promise<ConversationRow | null> {
  const existing = await getConversationForUser(conversationId, userId);
  if (!existing) return null;

  const merged: ConversationSettings = {
    ...(existing.settings ?? {}),
    ...settings,
  };

  const [updated] = await db
    .update(conversations)
    .set({
      settings: merged,
      updatedAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning();

  return updated ?? null;
}

export async function listUserConversations(
  userId: number,
  limit = 10
): Promise<ConversationRow[]> {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}
