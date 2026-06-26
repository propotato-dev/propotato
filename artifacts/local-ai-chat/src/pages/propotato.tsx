import { useState, useRef, useEffect, useCallback, useMemo } from "react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const API = `${BASE}/api`;

/* ─── Types ─────────────────────────────────────────────── */
interface ChatSummary { id: string; title: string; pinned: boolean; folder: string | null; }
interface ChatMessage { role: "user" | "assistant"; content: string; }
interface Settings {
  aiName: string; personality: string; responseLength: string;
  theme: string; customInstructions: string; aiAvatar: string; fontSize: number;
}
interface AttachedFile { name: string; data: string; mime: string; isImage: boolean; preview?: string; }

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null; onerror: ((e: Event) => void) | null;
}
interface SpeechRecognitionEvent extends Event { results: SpeechRecognitionResultList; }

/* ─── Defaults ───────────────────────────────────────────── */
const DEFAULT_SETTINGS: Settings = {
  aiName: "ProPotato", personality: "Friendly", responseLength: "Medium",
  theme: "Dark", customInstructions: "", aiAvatar: "🥔", fontSize: 15,
};
type Theme = "Dark" | "Light" | "Soft Light";

/* ─── Helpers ────────────────────────────────────────────── */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "Light") root.setAttribute("data-theme", "light");
  else if (theme === "Soft Light") root.setAttribute("data-theme", "soft-light");
  else root.removeAttribute("data-theme");
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text: string): string {
  // Code blocks — with copy button
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const trimmed = code.trimEnd();
    const safe = escHtml(trimmed);
    const encoded = encodeURIComponent(trimmed);
    return `<div class="pp-code-wrap"><div class="pp-code-header"><span class="pp-code-lang">${lang || "text"}</span><button class="pp-copy-btn" data-code="${encoded}">Copy</button></div><pre><code class="lang-${lang || "text"}">${safe}</code></pre></div>`;
  });
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${escHtml(c)}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/^#{1,3}\s+(.+)$/gm, "<strong>$1</strong>");
  text = text.replace(/^[-*+]\s+(.+)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>.*<\/li>(\n|$))+/g, m => `<ul>${m}</ul>`);
  text = text.split(/\n\n+/).map(p => {
    if (p.startsWith("<div class=\"pp-code") || p.startsWith("<ul>")) return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  return text;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block").replace(/`[^`]+`/g, m => m.slice(1, -1))
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,3}\s+/gm, "").replace(/^[-*+]\s+/gm, "").replace(/<[^>]+>/g, "");
}

function exportTxt(title: string, history: ChatMessage[], aiName: string): void {
  const lines = [`ProPotato Chat: ${title}`, "=".repeat(40), ""];
  for (const m of history) {
    lines.push(`${m.role === "user" ? "You" : aiName}:`);
    lines.push(m.content); lines.push("");
  }
  downloadFile(lines.join("\n"), `${title}.txt`, "text/plain");
}

function exportMd(title: string, history: ChatMessage[], aiName: string): void {
  const lines = [`# ${title}`, ""];
  for (const m of history) {
    lines.push(`**${m.role === "user" ? "You" : aiName}:** ${m.content}`, "");
  }
  downloadFile(lines.join("\n"), `${title}.md`, "text/markdown");
}

function downloadFile(content: string, filename: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}

function parseImportedTxt(text: string): { title: string; messages: ChatMessage[] } {
  const lines = text.split("\n");
  let title = "Imported Chat";
  const titleMatch = lines[0]?.match(/^.+?: (.+)$/);
  if (titleMatch) title = titleMatch[1].trim();
  const messages: ChatMessage[] = [];
  let role: "user" | "assistant" | null = null;
  let buf: string[] = [];
  const flush = () => { if (role && buf.join("").trim()) messages.push({ role, content: buf.join("\n").trim() }); buf = []; };
  for (let i = 2; i < lines.length; i++) {
    const l = lines[i];
    if (l === "You:") { flush(); role = "user"; }
    else if (l.endsWith(":") && !l.includes(" ")) { flush(); role = "assistant"; }
    else { buf.push(l); }
  }
  flush();
  return { title, messages };
}

const SLASH_COMMANDS = [
  { cmd: "/new", label: "New Chat", icon: "＋" },
  { cmd: "/export", label: "Export Chat (.txt)", icon: "↓" },
  { cmd: "/exportmd", label: "Export Chat (.md)", icon: "↓" },
  { cmd: "/import", label: "Import Chat", icon: "↑" },
  { cmd: "/clear", label: "Clear & New Chat", icon: "✕" },
];

/* ─── Component ──────────────────────────────────────────── */
export default function ProPotato() {
  const [showHome, setShowHome] = useState(() => !localStorage.getItem("pp_visited"));
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatSummary[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [folderEditId, setFolderEditId] = useState<string | null>(null);
  const [folderValue, setFolderValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [currentTheme, setCurrentTheme] = useState<Theme>("Dark");
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showCmdPalette, setShowCmdPalette] = useState(false);
  const [cmdFilter, setCmdFilter] = useState("");
  const [exportChatId, setExportChatId] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportTitle, setExportTitle] = useState("");
  const [exportHistory, setExportHistory] = useState<ChatMessage[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const chatBoxRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Init ── */
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/settings`);
        const d = await r.json();
        const s: Settings = { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) };
        setSettings(s); setSettingsDraft(s);
        applyTheme(s.theme as Theme); setCurrentTheme(s.theme as Theme);
        document.documentElement.style.setProperty("--font-size-base", `${s.fontSize}px`);
      } catch { /* use defaults */ }
      await loadChats();
    })();
  }, []);

  /* ── Close attach menu on outside click ── */
  useEffect(() => {
    if (!showAttachMenu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".pp-attach-wrap")) setShowAttachMenu(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showAttachMenu]);

  /* ── Scroll to bottom ── */
  useEffect(() => {
    if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
  }, [messages, isGenerating, suggestions]);

  /* ── Debounced search ── */
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    searchDebounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const r = await fetch(`${API}/chats/search?q=${encodeURIComponent(searchQuery)}`);
        setSearchResults(await r.json());
      } catch { setSearchResults(null); }
      finally { setIsSearching(false); }
    }, 400);
  }, [searchQuery]);

  const loadChats = useCallback(async () => {
    try { const r = await fetch(`${API}/chats`); const d = await r.json(); setChats(d); return d as ChatSummary[]; }
    catch { return [] as ChatSummary[]; }
  }, []);

  const selectChat = useCallback(async (chatId: string) => {
    setCurrentChatId(chatId); setSidebarOpen(false); setSuggestions([]);
    try {
      const r = await fetch(`${API}/chats/load`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) });
      const d = await r.json(); setMessages(d.history ?? []);
    } catch { setMessages([]); }
  }, []);

  const startNewChat = useCallback(async () => {
    if (isGenerating) return;
    try {
      const r = await fetch(`${API}/chats/new`, { method: "POST" });
      const d = await r.json();
      setCurrentChatId(d.chatId); setMessages([]); setSuggestions([]);
      setSidebarOpen(false); await loadChats();
    } catch { /* ignore */ }
  }, [isGenerating, loadChats]);

  /* ── Word count ── */
  const wordCount = useMemo(() => {
    const chars = input.length;
    const words = input.trim() ? input.trim().split(/\s+/).length : 0;
    return { chars, words };
  }, [input]);

  /* ── Copy code event delegation ── */
  const handleChatBoxClick = useCallback((e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest(".pp-copy-btn") as HTMLButtonElement | null;
    if (!btn) return;
    const encoded = btn.dataset.code ?? "";
    const code = decodeURIComponent(encoded);
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = "✓ Copied";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
    }).catch(() => {
      btn.textContent = "Failed";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  }, []);

  /* ── Send message ── */
  const handleSend = useCallback(async (overrideInput?: string) => {
    const text = (overrideInput ?? input).trim();
    if (!text && !attachedFile) return;
    if (isGenerating) return;

    // Slash command check
    if (text.startsWith("/") && !attachedFile) {
      const cmd = text.split(" ")[0].toLowerCase();
      if (cmd === "/new" || cmd === "/clear") { setInput(""); setShowCmdPalette(false); await startNewChat(); return; }
      if ((cmd === "/export" || cmd === "/exportmd") && currentChatId) {
        setInput(""); setShowCmdPalette(false);
        const r = await fetch(`${API}/chats/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: currentChatId }) });
        const data = await r.json();
        if (cmd === "/exportmd") exportMd(data.title, data.history, settings.aiName);
        else exportTxt(data.title, data.history, settings.aiName);
        return;
      }
      if (cmd === "/import") { setInput(""); setShowCmdPalette(false); importFileRef.current?.click(); return; }
    }

    const fileToSend = attachedFile;
    setInput(""); setAttachedFile(null); setShowCmdPalette(false); setSuggestions([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsGenerating(true); setShowAttachMenu(false);

    const displayContent = fileToSend
      ? (text ? `${text}\n\n[${fileToSend.isImage ? "📷" : "📄"} ${fileToSend.name}]` : `[${fileToSend.isImage ? "📷" : "📄"} ${fileToSend.name}]`)
      : text;

    setMessages(prev => [...prev, { role: "user", content: displayContent }]);

    const wasNew = !currentChatId;
    let chatId = currentChatId;
    if (!chatId) {
      const r = await fetch(`${API}/chats/new`, { method: "POST" });
      chatId = (await r.json()).chatId;
      setCurrentChatId(chatId);
    }

    const ctrl = new AbortController(); abortRef.current = ctrl;
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const body: Record<string, string> = {
        message: fileToSend?.isImage
          ? (text || "Describe this image in detail.")
          : (fileToSend ? `${text}\n\nFile contents of "${fileToSend.name}":\n${fileToSend.data}` : text),
        chatId: chatId!,
      };
      if (fileToSend?.isImage) { body.imageData = fileToSend.data; body.imageMime = fileToSend.mime; }

      const resp = await fetch(`${API}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: ctrl.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Request failed" }));
        setMessages(prev => [...prev.slice(0, -1), { role: "assistant", content: `[Error: ${err.error}]` }]);
        return;
      }

      const reader = resp.body!.getReader(); const decoder = new TextDecoder();
      let accumulated = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        accumulated += decoder.decode(value);
        setMessages(prev => [...prev.slice(0, -1), { role: "assistant", content: accumulated }]);
      }

      if (speakerOn && accumulated) speakText(accumulated);

      // Auto-title for new chats
      if (wasNew && chatId && text) {
        fetch(`${API}/chats/auto-title`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, firstMessage: text }),
        }).then(() => loadChats()).catch(() => {});
      }

      // Suggested replies (non-blocking)
      if (accumulated) {
        fetch(`${API}/chats/suggested-replies`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastAiMessage: accumulated }),
        }).then(r => r.json()).then(d => setSuggestions(d.suggestions ?? [])).catch(() => {});
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.content) return [...prev.slice(0, -1), { role: "assistant", content: "Stopped." }];
          return prev;
        });
      } else {
        setMessages(prev => [...prev.slice(0, -1), { role: "assistant", content: "[Connection error — please try again.]" }]);
      }
    } finally {
      setIsGenerating(false); abortRef.current = null;
      await loadChats();
    }
  }, [input, attachedFile, isGenerating, currentChatId, loadChats, speakerOn, settings.aiName, startNewChat]);

  const stopGeneration = () => { abortRef.current?.abort(); setIsGenerating(false); };

  /* ── Input change with / command ── */
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
    if (val.startsWith("/")) {
      setShowCmdPalette(true);
      setCmdFilter(val.toLowerCase());
    } else {
      setShowCmdPalette(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { setShowCmdPalette(false); return; }
    if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 768) {
      e.preventDefault();
      if (!isGenerating) handleSend();
    }
  };

  /* ── File attachment ── */
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const isImage = file.type.startsWith("image/");
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      if (isImage) {
        setAttachedFile({ name: file.name, data: result.split(",")[1], mime: file.type, isImage: true, preview: result });
      } else {
        setAttachedFile({ name: file.name, data: result, mime: file.type, isImage: false });
      }
    };
    if (isImage) reader.readAsDataURL(file); else reader.readAsText(file);
    e.target.value = ""; setShowAttachMenu(false);
  };

  /* ── Chat import ── */
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = reader.result as string;
      const { title, messages: msgs } = parseImportedTxt(text);
      if (!msgs.length) { alert("No messages found in file."); return; }
      const r = await fetch(`${API}/chats/import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, messages: msgs }),
      });
      const d = await r.json();
      await loadChats();
      await selectChat(d.chatId);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  /* ── Microphone ── */
  const toggleMic = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) { alert("Speech recognition is not supported in this browser. Try Chrome or Edge."); return; }
    if (isListening) { recognitionRef.current?.stop(); setIsListening(false); return; }
    const rec = new SR();
    rec.continuous = false; rec.interimResults = true; rec.lang = "en-US";
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      setInput(transcript);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
      }
    };
    rec.onend = () => setIsListening(false);
    rec.onerror = () => setIsListening(false);
    recognitionRef.current = rec; rec.start(); setIsListening(true); setShowAttachMenu(false);
  }, [isListening]);

  /* ── TTS ── */
  const speakText = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdown(text));
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  const stopSpeaking = () => { window.speechSynthesis?.cancel(); setIsSpeaking(false); };

  /* ── Pin ── */
  const handlePin = async (chatId: string) => {
    await fetch(`${API}/chats/pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) });
    await loadChats();
  };

  /* ── Folder ── */
  const saveFolder = async (chatId: string, folder: string) => {
    await fetch(`${API}/chats/set-folder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, folder: folder.trim() || null }),
    });
    setFolderEditId(null); await loadChats();
  };

  /* ── Export ── */
  const handleExport = async (chatId: string, format: "txt" | "md" = "txt") => {
    const r = await fetch(`${API}/chats/export`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }),
    });
    const data = await r.json();
    if (format === "md") exportMd(data.title, data.history, settings.aiName);
    else exportTxt(data.title, data.history, settings.aiName);
  };

  const openExportModal = async (chatId: string) => {
    const r = await fetch(`${API}/chats/export`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }),
    });
    const data = await r.json();
    setExportTitle(data.title); setExportHistory(data.history);
    setExportChatId(chatId); setShowExportModal(true);
  };

  /* ── Delete ── */
  const handleDeleteChat = async (chatId: string) => {
    await fetch(`${API}/chats/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) });
    if (currentChatId === chatId) { setCurrentChatId(null); setMessages([]); }
    setPendingDeleteId(null); await loadChats();
  };

  /* ── Rename ── */
  const handleRename = async (chatId: string, title: string) => {
    await fetch(`${API}/chats/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, title }) });
    setRenamingId(null); await loadChats();
  };

  /* ── Settings ── */
  const handleSaveSettings = async () => {
    const r = await fetch(`${API}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settingsDraft) });
    const d = await r.json();
    const s: Settings = { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) };
    setSettings(s); setSettingsDraft(s);
    applyTheme(s.theme as Theme); setCurrentTheme(s.theme as Theme);
    document.documentElement.style.setProperty("--font-size-base", `${s.fontSize}px`);
    setShowSettings(false);
  };

  const handleResetSettings = async () => {
    const r = await fetch(`${API}/settings`, { method: "DELETE" });
    const d = await r.json();
    const s: Settings = { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) };
    setSettings(s); setSettingsDraft(s);
    applyTheme(s.theme as Theme); setCurrentTheme(s.theme as Theme);
    document.documentElement.style.setProperty("--font-size-base", `${s.fontSize}px`);
  };

  const cycleTheme = () => {
    const order: Theme[] = ["Dark", "Soft Light", "Light"];
    const next = order[(order.indexOf(currentTheme) + 1) % order.length];
    setCurrentTheme(next); setSettingsDraft(p => ({ ...p, theme: next })); setSettings(p => ({ ...p, theme: next }));
    applyTheme(next);
    fetch(`${API}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, theme: next }) }).catch(() => {});
  };

  /* ── Derived ── */
  const displayChats = searchQuery.trim() ? (searchResults ?? []) : chats;
  const folders = useMemo(() => {
    const seen = new Set<string>();
    chats.forEach(c => { if (c.folder) seen.add(c.folder); });
    return Array.from(seen).sort();
  }, [chats]);

  const filteredCmds = SLASH_COMMANDS.filter(c => c.cmd.startsWith(cmdFilter) || c.label.toLowerCase().includes(cmdFilter.slice(1)));

  /* ═════════════════════════════════════════════════════
     HOME PAGE
  ═════════════════════════════════════════════════════ */
  if (showHome) {
    return (
      <div className="pp-home">
        <div className="pp-home-inner">
          <div className="pp-home-hero">
            <div className="pp-home-logo">🥔</div>
            <h1 className="pp-home-title">ProPotato</h1>
            <p className="pp-home-tagline">Your intelligent AI companion — chat, listen, and explore.</p>
          </div>
          <div className="pp-home-features">
            {[
              { icon: "💬", name: "Smart Chat", desc: "Multi-session conversations with memory and markdown" },
              { icon: "🎤", name: "Voice Input", desc: "Speak your message — no typing required" },
              { icon: "🔊", name: "AI Voice Replies", desc: "Hear responses spoken aloud in natural voice" },
              { icon: "📷", name: "Photos & Files", desc: "Upload images or text files and ask questions" },
            ].map(f => (
              <div className="pp-feature-card" key={f.name}>
                <div className="pp-feature-icon">{f.icon}</div>
                <div className="pp-feature-name">{f.name}</div>
                <div className="pp-feature-desc">{f.desc}</div>
              </div>
            ))}
          </div>
          <button className="pp-home-cta" onClick={async () => {
            localStorage.setItem("pp_visited", "1");
            setShowHome(false);
            const loaded = await loadChats();
            if (!loaded.length) await startNewChat();
          }}>Start Chatting →</button>
          <p className="pp-home-note">Your chats are saved locally to your device.</p>
        </div>
      </div>
    );
  }

  /* ═════════════════════════════════════════════════════
     MAIN APP
  ═════════════════════════════════════════════════════ */
  return (
    <div className="pp-app">
      {sidebarOpen && <div className="pp-backdrop" onClick={() => setSidebarOpen(false)} />}

      {/* ── Sidebar ── */}
      <div className={`pp-sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="pp-sidebar-top">
          <button className="pp-new-chat-btn" onClick={startNewChat}><span>＋</span> New chat</button>
          <button className="pp-theme-btn" onClick={cycleTheme} title={`Theme: ${currentTheme}`}>
            {currentTheme === "Dark" ? "D" : currentTheme === "Light" ? "L" : "S"}
          </button>
          <button className="pp-import-btn" title="Import chat" onClick={() => importFileRef.current?.click()}>↑</button>
        </div>

        <div className="pp-search-wrap">
          <span className="pp-search-icon">🔍</span>
          <input className="pp-search" placeholder="Search all messages…" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)} />
          {isSearching && <span className="pp-search-spin">↻</span>}
        </div>

        {/* Folder filter pills */}
        {folders.length > 0 && (
          <div className="pp-folder-pills">
            {folders.map(f => (
              <button key={f} className="pp-folder-pill" onClick={() => setSearchQuery(f)}>📁 {f}</button>
            ))}
          </div>
        )}

        <button className="pp-settings-btn" onClick={() => { setSettingsDraft(settings); setShowSettings(true); }}>
          ⚙ Settings / Personalization
        </button>

        <div className="pp-chat-list">
          {displayChats.length === 0 && searchQuery && (
            <div className="pp-no-results">No results for "{searchQuery}"</div>
          )}
          {displayChats.map(chat => (
            <div key={chat.id}
              className={`pp-chat-item${currentChatId === chat.id ? " active" : ""}${chat.pinned ? " pinned" : ""}`}
              onClick={() => renamingId !== chat.id && folderEditId !== chat.id && selectChat(chat.id)}>
              <div className="pp-chat-item-left">
                {chat.pinned && <span className="pp-pin-indicator">📌</span>}
                {renamingId === chat.id ? (
                  <input className="pp-rename-input" autoFocus value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => handleRename(chat.id, renameValue || chat.title)}
                    onKeyDown={e => { if (e.key === "Enter") handleRename(chat.id, renameValue || chat.title); if (e.key === "Escape") setRenamingId(null); }}
                    onClick={e => e.stopPropagation()} />
                ) : (
                  <span className="pp-chat-title">{chat.title}</span>
                )}
                {chat.folder && folderEditId !== chat.id && (
                  <span className="pp-chat-folder">📁 {chat.folder}</span>
                )}
                {folderEditId === chat.id && (
                  <input className="pp-folder-input" autoFocus placeholder="Folder name…" value={folderValue}
                    onChange={e => setFolderValue(e.target.value)}
                    onBlur={() => saveFolder(chat.id, folderValue)}
                    onKeyDown={e => { if (e.key === "Enter") saveFolder(chat.id, folderValue); if (e.key === "Escape") setFolderEditId(null); }}
                    onClick={e => e.stopPropagation()} />
                )}
              </div>
              <div className="pp-chat-actions">
                <button className="pp-action-btn" title={chat.pinned ? "Unpin" : "Pin"} onClick={e => { e.stopPropagation(); handlePin(chat.id); }}>📌</button>
                <button className="pp-action-btn" title="Set folder" onClick={e => { e.stopPropagation(); setFolderEditId(chat.id); setFolderValue(chat.folder ?? ""); }}>📁</button>
                <button className="pp-action-btn" title="Export" onClick={e => { e.stopPropagation(); openExportModal(chat.id); }}>↓</button>
                <button className="pp-action-btn" title="Rename" onClick={e => { e.stopPropagation(); setRenamingId(chat.id); setRenameValue(chat.title); }}>✎</button>
                <button className="pp-action-btn pp-delete-btn" title="Delete" onClick={e => { e.stopPropagation(); setPendingDeleteId(chat.id); }}>✕</button>
              </div>
            </div>
          ))}
        </div>
        <button className="pp-home-nav-btn" onClick={() => setShowHome(true)}>🏠 Home</button>
      </div>

      {/* ── Main ── */}
      <div className="pp-main">
        <div className="pp-header">
          <button className="pp-mobile-menu" onClick={() => setSidebarOpen(true)}>⋮</button>
          <span className="pp-header-logo">{settings.aiAvatar}</span>
          <span className="pp-header-title">{settings.aiName}</span>
          {isSpeaking && (
            <button className="pp-speaking-badge" onClick={stopSpeaking}>🔊 Speaking… (stop)</button>
          )}
        </div>

        <div className="pp-chat-box" ref={chatBoxRef} onClick={handleChatBoxClick}>
          {messages.length === 0 ? (
            <div className="pp-empty">
              <div className="pp-empty-icon">{settings.aiAvatar}</div>
              <p className="pp-empty-title">Start a conversation</p>
              <p className="pp-empty-sub">Ask {settings.aiName} anything — or type / for commands.</p>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`pp-message ${msg.role === "user" ? "pp-user" : "pp-ai"}`}>
                  {msg.role === "assistant" && msg.content === "" && isGenerating ? (
                    <span className="pp-thinking">Thinking…</span>
                  ) : msg.role === "assistant" ? (
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                  ) : (
                    <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
                  )}
                  {msg.role === "assistant" && msg.content && !isGenerating && speakerOn && (
                    <button className="pp-speak-btn" onClick={() => speakText(msg.content)}>🔊</button>
                  )}
                </div>
              ))}
              {/* Suggested replies */}
              {suggestions.length > 0 && !isGenerating && (
                <div className="pp-suggestions">
                  {suggestions.map((s, i) => (
                    <button key={i} className="pp-suggestion-chip" onClick={() => { setSuggestions([]); handleSend(s); }}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="pp-input-area">
          {/* Attached file preview */}
          {attachedFile && (
            <div className="pp-attach-preview">
              {attachedFile.isImage && attachedFile.preview && (
                <img src={attachedFile.preview} alt="preview" className="pp-attach-img-thumb" />
              )}
              <span>{attachedFile.isImage ? "📷" : "📄"} {attachedFile.name}</span>
              <button onClick={() => setAttachedFile(null)} className="pp-attach-remove">✕</button>
            </div>
          )}

          {/* Slash command palette */}
          {showCmdPalette && filteredCmds.length > 0 && (
            <div className="pp-cmd-palette">
              {filteredCmds.map(c => (
                <button key={c.cmd} className="pp-cmd-item" onClick={() => {
                  setInput(""); setShowCmdPalette(false);
                  handleSend(c.cmd);
                }}>
                  <span className="pp-cmd-icon">{c.icon}</span>
                  <span className="pp-cmd-label">{c.cmd}</span>
                  <span className="pp-cmd-desc">{c.label}</span>
                </button>
              ))}
            </div>
          )}

          <div className="pp-input-pill">
            {/* Attach menu */}
            <div className="pp-attach-wrap">
              <button className="pp-attach-btn" onClick={() => setShowAttachMenu(p => !p)}>＋</button>
              {showAttachMenu && (
                <div className="pp-attach-menu">
                  <button className="pp-attach-item" onClick={() => { fileInputRef.current!.accept = "image/*"; fileInputRef.current!.click(); }}>
                    <span className="pp-attach-item-icon">📷</span><span>Photo / Image</span>
                  </button>
                  <button className="pp-attach-item" onClick={() => { fileInputRef.current!.accept = ".txt,.md,.csv,.json,.py,.js,.ts,.html,.css"; fileInputRef.current!.click(); }}>
                    <span className="pp-attach-item-icon">📄</span><span>Text File</span>
                  </button>
                  <div className="pp-attach-divider" />
                  <button className={`pp-attach-item${isListening ? " active" : ""}`} onClick={toggleMic}>
                    <span className="pp-attach-item-icon">{isListening ? "🔴" : "🎤"}</span>
                    <span>{isListening ? "Stop Listening" : "Microphone"}</span>
                  </button>
                  <button className={`pp-attach-item${speakerOn ? " active" : ""}`} onClick={() => { if (isSpeaking) stopSpeaking(); setSpeakerOn(p => !p); setShowAttachMenu(false); }}>
                    <span className="pp-attach-item-icon">{speakerOn ? "🔊" : "🔇"}</span>
                    <span>Voice Replies {speakerOn ? "(On)" : "(Off)"}</span>
                  </button>
                </div>
              )}
            </div>

            <textarea ref={textareaRef}
              className={`pp-textarea${isListening ? " pp-listening" : ""}`}
              placeholder={isListening ? "🎤 Listening…" : `Message ${settings.aiName}… (type / for commands)`}
              value={input} rows={1} disabled={isGenerating && !isListening}
              onChange={handleInputChange} onKeyDown={handleKeyDown} />

            <button
              className={`pp-send-btn${isGenerating ? " is-stop" : ""}`}
              onClick={isGenerating ? stopGeneration : () => handleSend()}
              disabled={!isGenerating && !input.trim() && !attachedFile}>
              {isGenerating ? "■" : "↑"}
            </button>
          </div>

          {/* Word count + hint */}
          <div className="pp-input-footer">
            <span className="pp-input-hint">
              {isListening ? "🎤 Speak now" : "Enter to send · Shift+Enter for new line · type / for commands"}
            </span>
            {(wordCount.chars > 0) && (
              <span className="pp-word-count">{wordCount.words}w · {wordCount.chars}c</span>
            )}
          </div>
        </div>
      </div>

      {/* Hidden inputs */}
      <input type="file" ref={fileInputRef} style={{ display: "none" }} onChange={handleFileSelect} />
      <input type="file" ref={importFileRef} style={{ display: "none" }} accept=".txt,.md" onChange={handleImportFile} />

      {/* ── Export modal ── */}
      {showExportModal && (
        <div className="pp-modal-overlay" onClick={() => setShowExportModal(false)}>
          <div className="pp-modal" onClick={e => e.stopPropagation()}>
            <div className="pp-modal-title">Export: {exportTitle}</div>
            <div className="pp-modal-body">{exportHistory.length} messages</div>
            <div className="pp-modal-actions">
              <button className="pp-modal-btn pp-cancel" onClick={() => setShowExportModal(false)}>Cancel</button>
              <button className="pp-modal-btn pp-cancel" onClick={() => { handleExport(exportChatId!, "txt"); setShowExportModal(false); }}>
                Download .txt
              </button>
              <button className="pp-modal-btn pp-confirm-delete" style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                onClick={() => { handleExport(exportChatId!, "md"); setShowExportModal(false); }}>
                Download .md
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete modal ── */}
      {pendingDeleteId && (
        <div className="pp-modal-overlay" onClick={() => setPendingDeleteId(null)}>
          <div className="pp-modal" onClick={e => e.stopPropagation()}>
            <div className="pp-modal-title">Delete this chat?</div>
            <div className="pp-modal-body">This cannot be undone.</div>
            <div className="pp-modal-actions">
              <button className="pp-modal-btn pp-cancel" onClick={() => setPendingDeleteId(null)}>Cancel</button>
              <button className="pp-modal-btn pp-confirm-delete" onClick={() => handleDeleteChat(pendingDeleteId)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings modal ── */}
      {showSettings && (
        <div className="pp-modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="pp-modal pp-settings-modal" onClick={e => e.stopPropagation()}>
            <div className="pp-modal-title">⚙ Settings / Personalization</div>
            <div className="pp-settings-grid">
              <div className="pp-field-row">
                <div className="pp-field" style={{ flex: "0 0 80px" }}>
                  <label>Avatar</label>
                  <input className="pp-input pp-avatar-input" maxLength={8} value={settingsDraft.aiAvatar}
                    onChange={e => setSettingsDraft(p => ({ ...p, aiAvatar: e.target.value }))} />
                </div>
                <div className="pp-field" style={{ flex: 1 }}>
                  <label>AI Name</label>
                  <input className="pp-input" maxLength={40} value={settingsDraft.aiName}
                    onChange={e => setSettingsDraft(p => ({ ...p, aiName: e.target.value }))} />
                </div>
              </div>
              <div className="pp-field"><label>Personality</label>
                <select className="pp-select" value={settingsDraft.personality} onChange={e => setSettingsDraft(p => ({ ...p, personality: e.target.value }))}>
                  <option>Friendly</option><option>Professional</option><option>Funny</option><option>Teacher</option>
                </select>
              </div>
              <div className="pp-field"><label>Response Length</label>
                <select className="pp-select" value={settingsDraft.responseLength} onChange={e => setSettingsDraft(p => ({ ...p, responseLength: e.target.value }))}>
                  <option>Short</option><option>Medium</option><option>Detailed</option>
                </select>
              </div>
              <div className="pp-field"><label>Theme</label>
                <select className="pp-select" value={settingsDraft.theme} onChange={e => setSettingsDraft(p => ({ ...p, theme: e.target.value }))}>
                  <option>Dark</option><option>Light</option><option>Soft Light</option>
                </select>
              </div>
              <div className="pp-field">
                <label>Font Size — {settingsDraft.fontSize}px</label>
                <div className="pp-slider-row">
                  <span className="pp-slider-label">12</span>
                  <input type="range" min="12" max="22" step="1" value={settingsDraft.fontSize}
                    className="pp-slider"
                    onChange={e => {
                      const v = Number(e.target.value);
                      setSettingsDraft(p => ({ ...p, fontSize: v }));
                      document.documentElement.style.setProperty("--font-size-base", `${v}px`);
                    }} />
                  <span className="pp-slider-label">22</span>
                </div>
              </div>
              <div className="pp-field"><label>Custom Instructions</label>
                <textarea className="pp-settings-textarea" maxLength={2000} value={settingsDraft.customInstructions}
                  onChange={e => setSettingsDraft(p => ({ ...p, customInstructions: e.target.value }))} />
              </div>
            </div>
            <div className="pp-modal-actions">
              <button className="pp-modal-btn pp-cancel" onClick={() => setShowSettings(false)}>Close</button>
              <button className="pp-modal-btn pp-cancel" onClick={handleResetSettings}>Reset</button>
              <button className="pp-modal-btn pp-confirm-delete" onClick={handleSaveSettings}
                style={{ background: "var(--accent)", color: "var(--accent-text)" }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
