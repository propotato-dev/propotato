import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface Settings {
  aiName: string;
  personality: string;
  responseLength: string;
  theme: string;
  customInstructions: string;
  aiAvatar: string;
  fontSize: number;
}

export const DEFAULT_SETTINGS: Settings = {
  aiName: "ProPotato",
  personality: "Friendly",
  responseLength: "Medium",
  theme: "Dark",
  customInstructions: "",
  aiAvatar: "🥔",
  fontSize: 15,
};

const VALID_PERSONALITIES = new Set(["Friendly", "Professional", "Funny", "Teacher"]);
const VALID_LENGTHS = new Set(["Short", "Medium", "Detailed"]);
const VALID_THEMES = new Set(["Dark", "Light", "Soft Light"]);

export function cleanSettings(raw: Partial<Settings>): Settings {
  const fontSize = Number(raw.fontSize ?? DEFAULT_SETTINGS.fontSize);
  return {
    aiName: (String(raw.aiName ?? "").trim().slice(0, 40) || DEFAULT_SETTINGS.aiName),
    personality: VALID_PERSONALITIES.has(raw.personality ?? "") ? raw.personality! : DEFAULT_SETTINGS.personality,
    responseLength: VALID_LENGTHS.has(raw.responseLength ?? "") ? raw.responseLength! : DEFAULT_SETTINGS.responseLength,
    theme: VALID_THEMES.has(raw.theme ?? "") ? raw.theme! : DEFAULT_SETTINGS.theme,
    customInstructions: String(raw.customInstructions ?? "").trim().slice(0, 2000),
    aiAvatar: String(raw.aiAvatar ?? DEFAULT_SETTINGS.aiAvatar).trim().slice(0, 8) || DEFAULT_SETTINGS.aiAvatar,
    fontSize: Number.isFinite(fontSize) ? Math.min(22, Math.max(12, fontSize)) : DEFAULT_SETTINGS.fontSize,
  };
}

const GLOBAL_KEY = "global";

export async function readSettings(): Promise<Settings> {
  const row = await db.select().from(settingsTable).where(eq(settingsTable.key, GLOBAL_KEY)).limit(1);
  if (!row.length) return { ...DEFAULT_SETTINGS };
  try { return cleanSettings(JSON.parse(row[0].value) as Partial<Settings>); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveSettings(raw: Partial<Settings>): Promise<Settings> {
  const clean = cleanSettings(raw);
  const value = JSON.stringify(clean);
  const existing = await db.select().from(settingsTable).where(eq(settingsTable.key, GLOBAL_KEY)).limit(1);
  if (existing.length) {
    await db.update(settingsTable).set({ value }).where(eq(settingsTable.key, GLOBAL_KEY));
  } else {
    await db.insert(settingsTable).values({ key: GLOBAL_KEY, value });
  }
  return clean;
}

export async function resetSettings(): Promise<Settings> {
  await db.delete(settingsTable).where(eq(settingsTable.key, GLOBAL_KEY));
  return { ...DEFAULT_SETTINGS };
}
