import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  real,
  timestamp,
  jsonb,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export interface ConversationSettings {
  modelOverride?: string;
  temperature?: number;
  responseStyle?: "balanced" | "concise" | "detailed";
  enableTools?: boolean; // Phase 3 architectural hook
  enableMultimodal?: boolean; // Phase 2 architectural hook
}

export interface MessageMetadata {
  phase?: 1 | 2 | 3;
  attachments?: Array<{
    type: "image" | "document" | "voice" | "audio";
    mimeType?: string;
    fileId?: string;
  }>;
  finishReason?: string;
  tokenEstimate?: number;
}

export const telegramUsers = pgTable(
  "telegram_users",
  {
    id: serial("id").primaryKey(),
    telegramId: text("telegram_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    languageCode: text("language_code").default("en"),
    isBot: boolean("is_bot").notNull().default(false),
    isBlocked: boolean("is_blocked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_users_telegram_id_uidx").on(table.telegramId),
  ]
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => telegramUsers.id, { onDelete: "cascade" }),
    preferredModel: text("preferred_model"),
    responseStyle: text("response_style").notNull().default("balanced"),
    temperature: real("temperature").notNull().default(0.7),
    maxHistoryMessages: integer("max_history_messages").notNull().default(20),
    language: text("language").notNull().default("en"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_preferences_user_id_uidx").on(table.userId),
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => telegramUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Active Conversation"),
    isActive: boolean("is_active").notNull().default(true),
    summary: text("summary"),
    messageCount: integer("message_count").notNull().default(0),
    settings: jsonb("settings").$type<ConversationSettings>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resetAt: timestamp("reset_at", { withTimezone: true }),
  },
  (table) => [
    index("conversations_user_active_idx").on(table.userId, table.isActive),
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => telegramUsers.id, { onDelete: "cascade" }),
    telegramMessageId: text("telegram_message_id"),
    role: text("role").notNull(), // 'user' | 'assistant' | 'system'
    content: text("content").notNull(),
    contentType: text("content_type").notNull().default("text"), // 'text' | 'image' | 'document' | 'voice'
    metadata: jsonb("metadata").$type<MessageMetadata>().notNull().default({}),
    modelUsed: text("model_used"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("messages_user_idx").on(table.userId),
  ]
);

export const processedUpdates = pgTable(
  "processed_updates",
  {
    updateId: bigint("update_id", { mode: "number" }).primaryKey(),
    telegramUserId: text("telegram_user_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("processed_updates_processed_at_idx").on(table.processedAt),
  ]
);

export type TelegramUserRow = typeof telegramUsers.$inferSelect;
export type UserPreferencesRow = typeof userPreferences.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
