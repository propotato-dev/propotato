import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const chatSessionsTable = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  title: text("title").notNull().default("New Chat"),
  pinned: boolean("pinned").notNull().default(false),
  folder: text("folder"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatSession = typeof chatSessionsTable.$inferSelect;
