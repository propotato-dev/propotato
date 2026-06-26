import Groq from "groq-sdk";
import { logger } from "./logger";

export const groqClient = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL ?? "llama-3.1-8b-instant";
export const FALLBACK_MODEL = process.env.GROQ_FALLBACK_TEXT_MODEL ?? "llama-3.3-70b-versatile";
export const VISION_MODEL = process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

const SYSTEM_PROMPT = `You are ProPotato, a helpful, general-purpose AI assistant.
You can help with a wide range of topics — answering questions, explaining
concepts, writing, brainstorming, casual conversation, coding help, and more.

BEHAVIOR RULES:
- Be clear, direct, and genuinely helpful. Match your response length to the question.
- Use markdown formatting where it helps readability.
- For math questions: show your work step-by-step.
- You have NO live internet access and cannot verify facts in real time.
- Be conversational and personable, not robotic or overly formal.

You are ProPotato. Be genuinely useful, honest about what you don't know, and easy to talk to.`;

const PERSONALITY_RULES: Record<string, string> = {
  Friendly: "Use a warm, clear, supportive tone.",
  Professional: "Use a concise, polished, work-focused tone.",
  Funny: "Use light humor when it fits, without sacrificing accuracy.",
  Teacher: "Explain ideas step by step and help the user learn.",
};

const LENGTH_RULES: Record<string, string> = {
  Short: "Prefer short answers unless the user asks for detail.",
  Medium: "Use balanced answers with enough context to be useful.",
  Detailed: "Give thorough answers with clear structure when helpful.",
};

export function buildSystemPrompt(settings: {
  aiName: string;
  personality: string;
  responseLength: string;
  customInstructions: string;
}): string {
  const personalityRule = PERSONALITY_RULES[settings.personality] ?? PERSONALITY_RULES["Friendly"];
  const lengthRule = LENGTH_RULES[settings.responseLength] ?? LENGTH_RULES["Medium"];

  const extras = [
    `Your visible assistant name is ${settings.aiName}.`,
    personalityRule,
    lengthRule,
  ];
  if (settings.customInstructions) {
    extras.push(`User custom instructions: ${settings.customInstructions}`);
  }

  return (
    SYSTEM_PROMPT.replace("ProPotato", settings.aiName) +
    "\n\nPERSONALIZATION:\n- " +
    extras.join("\n- ")
  );
}

export function getTokenLimit(responseLength: string): number {
  return { Short: 700, Medium: 1400, Detailed: 2048 }[responseLength] ?? 1400;
}

export async function generateTitle(firstMessage: string): Promise<string> {
  if (!groqClient) return firstMessage.slice(0, 40);
  try {
    const resp = await groqClient.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: "system", content: "Generate a concise 3-5 word title for this chat conversation. Reply with ONLY the title — no quotes, no punctuation at end, no extra words." },
        { role: "user", content: firstMessage.slice(0, 400) },
      ],
      max_tokens: 20, temperature: 0.7, stream: false,
    });
    return resp.choices[0]?.message?.content?.trim().slice(0, 60) ?? firstMessage.slice(0, 40);
  } catch { return firstMessage.slice(0, 40); }
}

export async function generateSuggestions(lastAiMsg: string): Promise<string[]> {
  if (!groqClient) return [];
  try {
    const resp = await groqClient.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: "system", content: "Based on this AI response, write exactly 3 short follow-up questions a user might ask next. One per line, no numbering, no bullets, no extra text." },
        { role: "user", content: lastAiMsg.slice(0, 600) },
      ],
      max_tokens: 100, temperature: 0.8, stream: false,
    });
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    return text.split("\n").map(s => s.replace(/^[-\d.)•\s]+/, "").trim()).filter(Boolean).slice(0, 3);
  } catch { return []; }
}

export async function* streamGroqResponse(
  messages: Groq.Chat.ChatCompletionMessageParam[],
  model: string,
  maxTokens: number
): AsyncGenerator<string> {
  if (!groqClient) {
    yield "[Error: GROQ_API_KEY is not set. Please add it in your environment secrets.]";
    return;
  }

  let stream;
  try {
    stream = await groqClient.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
    });
  } catch (err) {
    if (model !== FALLBACK_MODEL) {
      logger.warn({ err, model }, "Primary model failed, trying fallback");
      try {
        stream = await groqClient.chat.completions.create({
          model: FALLBACK_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
          stream: true,
        });
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr }, "Fallback model also failed");
        yield `[ProPotato Error: The AI service failed. Please check your API key and try again.]`;
        return;
      }
    } else {
      logger.error({ err }, "Groq stream failed");
      yield `[ProPotato Error: The AI service failed. Please check your API key and try again.]`;
      return;
    }
  }

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (token) yield token;
  }
}
