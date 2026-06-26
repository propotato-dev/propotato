import { db } from "@workspace/db";
import { chatSessionsTable, chatMessagesTable } from "@workspace/db";
import { eq, and, desc, or, ilike } from "drizzle-orm";

export interface ChatMessage { role: "user" | "assistant"; content: string; }
export interface ChatSummary { id: string; title: string; pinned: boolean; folder: string | null; }

export async function getAllChats(deviceId: string): Promise<ChatSummary[]> {
  const sessions = await db
    .select()
    .from(chatSessionsTable)
    .where(eq(chatSessionsTable.deviceId, deviceId))
    .orderBy(desc(chatSessionsTable.pinned), desc(chatSessionsTable.updatedAt));
  return sessions.map((s) => ({ id: s.id, title: s.title, pinned: s.pinned, folder: s.folder ?? null }));
}

export async function createChat(deviceId: string, title = "New Chat"): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(chatSessionsTable).values({ id, deviceId, title });
  return id;
}

export async function loadChat(chatId: string, deviceId: string): Promise<ChatMessage[]> {
  const session = await db.select().from(chatSessionsTable)
    .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId))).limit(1);
  if (!session.length) return [];
  const messages = await db.select().from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatId, chatId)).orderBy(chatMessagesTable.createdAt);
  return messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

export async function appendMessage(
  chatId: string, deviceId: string, role: "user" | "assistant", content: string
): Promise<void> {
  await db.insert(chatMessagesTable).values({ chatId, role, content });
  if (role === "user") {
    const session = await db.select().from(chatSessionsTable)
      .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId))).limit(1);
    if (session[0]?.title === "New Chat") {
      await db.update(chatSessionsTable)
        .set({ title: content.slice(0, 50), updatedAt: new Date() })
        .where(eq(chatSessionsTable.id, chatId));
    } else {
      await db.update(chatSessionsTable).set({ updatedAt: new Date() }).where(eq(chatSessionsTable.id, chatId));
    }
  }
}

export async function updateTitle(chatId: string, deviceId: string, title: string): Promise<void> {
  await db.update(chatSessionsTable)
    .set({ title: title.slice(0, 60) })
    .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId)));
}

export async function renameChat(chatId: string, deviceId: string, title: string): Promise<void> {
  await db.update(chatSessionsTable).set({ title })
    .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId)));
}

export async function pinChat(chatId: string, deviceId: string): Promise<boolean> {
  const session = await db.select().from(chatSessionsTable)
    .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId))).limit(1);
  if (!session.length) return false;
  const newPinned = !session[0].pinned;
  await db.update(chatSessionsTable).set({ pinned: newPinned })
    .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId)));
  return newPinned;
}

export async function setFolder(chatId: string, deviceId: string, folder: string | null): Promise<void> {
  await db.update(chatSessionsTable).set({ folder: folder || null })
    .where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId)));
}

export async function searchChats(deviceId: string, query: string): Promise<ChatSummary[]> {
  const q = `%${query}%`;
  const titleMatches = await db.select().from(chatSessionsTable)
    .where(and(eq(chatSessionsTable.deviceId, deviceId), ilike(chatSessionsTable.title, q)))
    .orderBy(desc(chatSessionsTable.updatedAt)).limit(20);

  const msgMatches = await db
    .select({ chatId: chatMessagesTable.chatId })
    .from(chatMessagesTable)
    .where(ilike(chatMessagesTable.content, q))
    .limit(50);

  const chatIdsFromMsgs = [...new Set(msgMatches.map(m => m.chatId))];
  const titleIds = new Set(titleMatches.map(s => s.id));
  const extraIds = chatIdsFromMsgs.filter(id => !titleIds.has(id));

  const extraSessions = extraIds.length
    ? await db.select().from(chatSessionsTable)
        .where(and(eq(chatSessionsTable.deviceId, deviceId), or(...extraIds.map(id => eq(chatSessionsTable.id, id)))))
        .limit(20)
    : [];

  return [...titleMatches, ...extraSessions].map(s => ({
    id: s.id, title: s.title, pinned: s.pinned, folder: s.folder ?? null,
  }));
}

export async function importChat(deviceId: string, title: string, messages: ChatMessage[]): Promise<string> {
  const id = await createChat(deviceId, title.slice(0, 60) || "Imported Chat");
  for (const msg of messages) {
    await db.insert(chatMessagesTable).values({ chatId: id, role: msg.role, content: msg.content });
  }
  await db.update(chatSessionsTable).set({ updatedAt: new Date() }).where(eq(chatSessionsTable.id, id));
  return id;
}

export async function deleteChat(chatId: string, deviceId: string): Promise<void> {
  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.chatId, chatId));
  await db.delete(chatSessionsTable).where(and(eq(chatSessionsTable.id, chatId), eq(chatSessionsTable.deviceId, deviceId)));
}
