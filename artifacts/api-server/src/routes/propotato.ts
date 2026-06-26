import { Router, type Request, type Response, type IRouter } from "express";
import { buildSystemPrompt, getTokenLimit, streamGroqResponse, TEXT_MODEL, VISION_MODEL, generateTitle, generateSuggestions } from "../lib/groq";
import {
  getAllChats, createChat, loadChat, appendMessage,
  renameChat, deleteChat, pinChat, setFolder, searchChats,
  importChat, updateTitle,
} from "../lib/chat-store";
import { readSettings, saveSettings, resetSettings, cleanSettings } from "../lib/settings-store";

const router: IRouter = Router();
const DEVICE_COOKIE = "propotato_device_id";

function getOrCreateDeviceId(req: Request, res: Response): string {
  const existing = req.cookies?.[DEVICE_COOKIE] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  res.cookie(DEVICE_COOKIE, id, { maxAge: 60 * 60 * 24 * 365 * 1000, httpOnly: true, sameSite: "lax" });
  return id;
}

router.get("/chats", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  res.json(await getAllChats(deviceId));
});

router.post("/chats/new", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const chatId = await createChat(deviceId);
  res.status(201).json({ chatId });
});

router.post("/chats/load", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId } = req.body as { chatId?: string };
  if (!chatId) { res.status(400).json({ error: "Missing chatId" }); return; }
  res.json({ history: await loadChat(chatId, deviceId) });
});

router.post("/chats/rename", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId, title } = req.body as { chatId?: string; title?: string };
  if (!chatId || !title) { res.status(400).json({ error: "Missing chatId or title" }); return; }
  await renameChat(chatId, deviceId, title.trim().slice(0, 60));
  res.json({ status: "ok" });
});

router.post("/chats/delete", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId } = req.body as { chatId?: string };
  if (!chatId) { res.status(400).json({ error: "Missing chatId" }); return; }
  await deleteChat(chatId, deviceId);
  res.json({ status: "ok" });
});

router.post("/chats/pin", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId } = req.body as { chatId?: string };
  if (!chatId) { res.status(400).json({ error: "Missing chatId" }); return; }
  const pinned = await pinChat(chatId, deviceId);
  res.json({ pinned });
});

router.post("/chats/set-folder", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId, folder } = req.body as { chatId?: string; folder?: string };
  if (!chatId) { res.status(400).json({ error: "Missing chatId" }); return; }
  await setFolder(chatId, deviceId, folder ?? null);
  res.json({ status: "ok" });
});

router.get("/chats/search", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.json([]); return; }
  res.json(await searchChats(deviceId, q));
});

router.post("/chats/export", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId, format } = req.body as { chatId?: string; format?: string };
  if (!chatId) { res.status(400).json({ error: "Missing chatId" }); return; }
  const history = await loadChat(chatId, deviceId);
  const chats = await getAllChats(deviceId);
  const chat = chats.find((c) => c.id === chatId);
  res.json({ title: chat?.title ?? "ProPotato Chat", history, format: format ?? "txt" });
});

router.post("/chats/import", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { title, messages } = req.body as { title?: string; messages?: Array<{ role: string; content: string }> };
  if (!messages?.length) { res.status(400).json({ error: "No messages to import" }); return; }
  const safeMessages = messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role as "user" | "assistant", content: String(m.content ?? "").slice(0, 8000) }));
  const chatId = await importChat(deviceId, title ?? "Imported Chat", safeMessages);
  res.status(201).json({ chatId });
});

router.post("/chats/auto-title", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { chatId, firstMessage } = req.body as { chatId?: string; firstMessage?: string };
  if (!chatId || !firstMessage) { res.status(400).json({ error: "Missing chatId or firstMessage" }); return; }
  const title = await generateTitle(firstMessage);
  await updateTitle(chatId, deviceId, title);
  res.json({ title });
});

router.post("/chats/suggested-replies", async (req, res): Promise<void> => {
  const { lastAiMessage } = req.body as { lastAiMessage?: string };
  if (!lastAiMessage) { res.json({ suggestions: [] }); return; }
  const suggestions = await generateSuggestions(lastAiMessage);
  res.json({ suggestions });
});

router.get("/settings", async (_req, res): Promise<void> => {
  res.json({ settings: await readSettings() });
});

router.post("/settings", async (req, res): Promise<void> => {
  res.json({ settings: await saveSettings(req.body as Parameters<typeof cleanSettings>[0]) });
});

router.delete("/settings", async (_req, res): Promise<void> => {
  res.json({ settings: await resetSettings() });
});

router.post("/chat", async (req, res): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const { message, chatId: rawChatId, imageData, imageMime } = req.body as {
    message?: string; chatId?: string; imageData?: string; imageMime?: string;
  };

  const userMessage = String(message ?? "").trim();
  if (!userMessage && !imageData) { res.status(400).json({ error: "No message provided" }); return; }

  let chatId = rawChatId;
  const isNewChat = !chatId;
  if (!chatId) chatId = await createChat(deviceId);

  const settings = await readSettings();
  const history = await loadChat(chatId, deviceId);
  const storedMessage = userMessage || "[Image attached]";
  await appendMessage(chatId, deviceId, "user", storedMessage);

  const systemPrompt = buildSystemPrompt(settings);
  type MsgParam = { role: "system" | "user" | "assistant"; content: string | unknown[] };
  const groqMessages: MsgParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  if (imageData) {
    const imgUrl = `data:${imageMime ?? "image/jpeg"};base64,${imageData}`;
    const parts: unknown[] = [{ type: "image_url", image_url: { url: imgUrl } }];
    if (userMessage) parts.unshift({ type: "text", text: userMessage });
    groqMessages.push({ role: "user", content: parts });
  } else {
    groqMessages.push({ role: "user", content: userMessage });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Chat-ID", chatId);
  res.setHeader("X-New-Chat", isNewChat ? "1" : "0");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  let accumulated = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = streamGroqResponse(groqMessages as any, imageData ? VISION_MODEL : TEXT_MODEL, getTokenLimit(settings.responseLength));
  for await (const token of gen) { accumulated += token; res.write(token); }
  res.end();

  await appendMessage(chatId, deviceId, "assistant", accumulated);
});

export default router;
