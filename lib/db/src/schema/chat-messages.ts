import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
