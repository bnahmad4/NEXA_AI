import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  telegramUsers,
  userPreferences,
  conversations,
  messages,
  type TelegramUserRow,
  type UserPreferencesRow,
} from "@/db/schema";

export interface UpsertTelegramUserInput {
  telegramId: string | number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  isBot?: boolean;
}

export async function upsertTelegramUser(
  input: UpsertTelegramUserInput
): Promise<TelegramUserRow> {
  const telegramIdStr = String(input.telegramId);
  const now = new Date();

  const [user] = await db
    .insert(telegramUsers)
    .values({
      telegramId: telegramIdStr,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      languageCode: input.languageCode ?? "en",
      isBot: input.isBot ?? false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: telegramUsers.telegramId,
      set: {
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        languageCode: input.languageCode ?? "en",
        updatedAt: now,
      },
    })
    .returning();

  // Ensure default user preferences row exists
  await db
    .insert(userPreferences)
    .values({
      userId: user.id,
      language: input.languageCode ?? "en",
    })
    .onConflictDoNothing({ target: userPreferences.userId });

  return user;
}

export async function findUserByTelegramId(
  telegramId: string | number
): Promise<TelegramUserRow | null> {
  const [row] = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.telegramId, String(telegramId)))
    .limit(1);

  return row ?? null;
}

export async function getUserPreferences(
  userId: number
): Promise<UserPreferencesRow> {
  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(userPreferences)
    .values({ userId })
    .onConflictDoNothing({ target: userPreferences.userId })
    .returning();

  if (created) return created;

  const [refetched] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  return refetched;
}

export async function updateUserPreferences(
  userId: number,
  updates: Partial<Pick<UserPreferencesRow, "preferredModel" | "responseStyle" | "temperature" | "maxHistoryMessages" | "language">>
): Promise<UserPreferencesRow> {
  await getUserPreferences(userId);

  const [updated] = await db
    .update(userPreferences)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(userPreferences.userId, userId))
    .returning();

  return updated;
}

export async function deleteUserDataByTelegramId(
  telegramId: string | number
): Promise<boolean> {
  const deleted = await db
    .delete(telegramUsers)
    .where(eq(telegramUsers.telegramId, String(telegramId)))
    .returning({ id: telegramUsers.id });

  return deleted.length > 0;
}

export async function getAggregateSystemStats(): Promise<{
  totalUsers: number;
  activeConversations: number;
  totalConversations: number;
  totalMessages: number;
}> {
  const [userCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(telegramUsers);
  const [convCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations);
  const [activeConvCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.isActive, true));
  const [msgCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages);

  return {
    totalUsers: userCount?.count ?? 0,
    totalConversations: convCount?.count ?? 0,
    activeConversations: activeConvCount?.count ?? 0,
    totalMessages: msgCount?.count ?? 0,
  };
}
