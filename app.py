import os
import json
import uuid
import time
import sqlite3
import urllib.parse
import logging
import requests
from collections import defaultdict, deque
from flask import Flask, request, Response, jsonify, render_template_string, send_from_directory, make_response
from groq import Groq

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# ============================================================
# CONFIGURATION
# ============================================================
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
WOLFRAM_APP_ID = os.getenv("WOLFRAM_APP_ID")

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

GROQ_TEXT_MODEL = os.getenv("GROQ_TEXT_MODEL", "llama-3.1-8b-instant")
GROQ_FALLBACK_TEXT_MODEL = os.getenv("GROQ_FALLBACK_TEXT_MODEL", "llama-3.3-70b-versatile")
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")

STORAGE_DIR = "chat_history"
MEMORY_DB = "propotato_production_memory.db"
SETTINGS_FILE = "propotato_settings.json"

MAX_IMAGE_BASE64_CHARS = 8_000_000  # ~6MB raw image data
MEMORY_RECALL_LIMIT = 10
WOLFRAM_TIMEOUT_SECONDS = 15

DEVICE_COOKIE_NAME = "propotato_device_id"
DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365  # 1 year
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"

if not os.path.exists(STORAGE_DIR):
    os.makedirs(STORAGE_DIR)


DEFAULT_SETTINGS = {
    "ai_name": "ProPotato",
    "personality": "Friendly",
    "response_length": "Medium",
    "theme": "Dark",
    "custom_instructions": ""
}

VALID_PERSONALITIES = {"Friendly", "Professional", "Funny", "Teacher"}
VALID_RESPONSE_LENGTHS = {"Short", "Medium", "Detailed"}
VALID_THEMES = {"Dark", "Light", "Soft Light"}


def clean_settings(raw_settings):
    settings = dict(DEFAULT_SETTINGS)
    if isinstance(raw_settings, dict):
        settings.update(raw_settings)

    ai_name = str(settings.get("ai_name", "")).strip()[:40]
    custom_instructions = str(settings.get("custom_instructions", "")).strip()[:2000]

    settings["ai_name"] = ai_name or DEFAULT_SETTINGS["ai_name"]
    settings["personality"] = settings.get("personality") if settings.get("personality") in VALID_PERSONALITIES else DEFAULT_SETTINGS["personality"]
    settings["response_length"] = settings.get("response_length") if settings.get("response_length") in VALID_RESPONSE_LENGTHS else DEFAULT_SETTINGS["response_length"]
    settings["theme"] = settings.get("theme") if settings.get("theme") in VALID_THEMES else DEFAULT_SETTINGS["theme"]
    settings["custom_instructions"] = custom_instructions
    return settings


def read_settings():
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return clean_settings(json.load(f))
    except Exception as e:
        app.logger.warning("Settings read failed: %s", e)
    return dict(DEFAULT_SETTINGS)


def save_settings(settings):
    clean = clean_settings(settings)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(clean, f, indent=2)
    return clean


def build_system_prompt(settings):
    settings = clean_settings(settings)
    name = settings["ai_name"]
    personality = settings["personality"]
    response_length = settings["response_length"]

    personality_rules = {
        "Friendly": "Use a warm, clear, supportive tone.",
        "Professional": "Use a concise, polished, work-focused tone.",
        "Funny": "Use light humor when it fits, without sacrificing accuracy.",
        "Teacher": "Explain ideas step by step and help the user learn."
    }
    length_rules = {
        "Short": "Prefer short answers unless the user asks for detail.",
        "Medium": "Use balanced answers with enough context to be useful.",
        "Detailed": "Give thorough answers with clear structure when helpful."
    }

    custom = settings.get("custom_instructions", "")
    extra = [
        f"Your visible assistant name is {name}.",
        personality_rules[personality],
        length_rules[response_length]
    ]
    if custom:
        extra.append(f"User custom instructions: {custom}")

    return SYSTEM_PROMPT.replace("ProPotato", name) + "\n\nPERSONALIZATION:\n- " + "\n- ".join(extra)


def response_token_limit(settings):
    return {"Short": 700, "Medium": 1400, "Detailed": 2048}.get(settings.get("response_length"), 1400)


def set_device_cookie(response, device_id):
    response.set_cookie(
        DEVICE_COOKIE_NAME,
        device_id,
        max_age=DEVICE_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="Lax",
        secure=COOKIE_SECURE
    )
    return response


def normalize_image_data_url(image_value):
    """Accept a browser data URL or raw base64 and return a valid data URL."""
    if not isinstance(image_value, str) or not image_value.strip():
        return None, None

    image_value = image_value.strip()
    if image_value.startswith("data:image/") and "base64," in image_value:
        _, base64_data = image_value.split("base64,", 1)
        return image_value, base64_data

    if "base64," in image_value:
        _, base64_data = image_value.split("base64,", 1)
        return f"data:image/png;base64,{base64_data}", base64_data

    return f"data:image/png;base64,{image_value}", image_value


def get_or_assign_device_id():
    """Reads the device-scoping cookie from the incoming request if present.
    Returns the existing ID, or None if this is a brand new visitor — in
    which case the calling route is responsible for generating a fresh ID
    and attaching it as a cookie on its own response."""
    return request.cookies.get(DEVICE_COOKIE_NAME)

# ============================================================
# RATE LIMITING (simple in-memory sliding window)
# ============================================================
# Maps IP address -> deque of request timestamps within the window.
# This is process-local (resets on restart, doesn't share across
# multiple server instances) but is sufficient for a single-instance
# ngrok-exposed personal project.
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 20
_rate_limit_buckets = defaultdict(deque)


def is_rate_limited(identifier):
    """Returns True if this identifier has exceeded the allowed request
    rate within the current sliding window."""
    now = time.time()
    bucket = _rate_limit_buckets[identifier]

    # Drop timestamps older than the window
    while bucket and now - bucket[0] > RATE_LIMIT_WINDOW_SECONDS:
        bucket.popleft()

    if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
        return True

    bucket.append(now)
    return False


def get_client_identifier():
    """Best-effort client identifier for rate limiting. Falls back to
    remote_addr; X-Forwarded-For is checked first since ngrok/proxies
    rewrite the direct connecting IP."""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


# ============================================================
# PROPOTATO SYSTEM PROMPT — Science & Math Specialist
# ============================================================
SYSTEM_PROMPT = """You are ProPotato, a helpful, general-purpose AI assistant.
You can help with a wide range of topics — answering questions, explaining
concepts, writing, brainstorming, casual conversation, coding help, and more.
You are not limited to any one subject area.

BEHAVIOR RULES:
- Be clear, direct, and genuinely helpful. Match your response length to the
  question — short questions get short answers, complex questions get
  thorough ones. Don't pad responses unnecessarily.
- Use markdown formatting where it helps readability: **bold** for emphasis,
  `code` for code/technical terms, fenced code blocks for multi-line code,
  and lists where they make information easier to scan.
- For math questions: if a question has an actual solvable answer, show your
  work step-by-step. If a question is underspecified, ambiguous, or has no
  unique/meaningful solution, say so immediately and explain why, rather than
  generating filler derivations to look like you solved it.
- You may receive a "Wolfram Alpha computed result" as additional context for
  some math/calculation questions. Treat it as a trusted calculation, but
  explain it in your own words rather than pasting it verbatim.
- For images, you can genuinely see and analyze visual content directly.
- You have NO live internet access and cannot verify facts in real time.
  For specific factual claims you're not confident about (niche trivia,
  fictional lore details, recent events, specific dates/numbers), say so
  clearly rather than stating them as certain fact. It's better to say
  "I'm not fully sure about this" than to confidently state something wrong.
- Be conversational and personable, not robotic or overly formal.

You are ProPotato. Be genuinely useful, honest about what you don't know,
and easy to talk to."""


# ============================================================
# MEMORY DATABASE FUNCTIONS
# ============================================================
def init_memory_db():
    try:
        conn = sqlite3.connect(MEMORY_DB)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                role TEXT,
                content TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_user_id
            ON messages(user_id)
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Memory DB init error: {e}")


init_memory_db()


def save_to_memory(user_id, role, content):
    try:
        if isinstance(content, str) and content and len(content) < 5000:
            conn = sqlite3.connect(MEMORY_DB)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)",
                (user_id, role, content)
            )
            conn.commit()
            conn.close()
    except Exception as e:
        print(f"Memory save error: {e}")


def get_memory_context(user_id, limit=MEMORY_RECALL_LIMIT):
    try:
        conn = sqlite3.connect(MEMORY_DB)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT role, content FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
            (user_id, limit)
        )
        rows = cursor.fetchall()
        conn.close()
        rows.reverse()
        return rows
    except Exception as e:
        print(f"Memory fetch error: {e}")
        return []


def prune_old_memory(user_id, keep_last=500):
    try:
        conn = sqlite3.connect(MEMORY_DB)
        cursor = conn.cursor()
        cursor.execute("""
            DELETE FROM messages
            WHERE user_id = ?
            AND id NOT IN (
                SELECT id FROM messages
                WHERE user_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            )
        """, (user_id, user_id, keep_last))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Memory prune error: {e}")


# ============================================================
# WOLFRAM ALPHA INTEGRATION
# ============================================================
def should_use_wolfram(user_prompt):
    """Lightweight heuristic to decide whether a query looks like a
    computational question Wolfram Alpha could help with. Not perfect,
    but avoids burning Wolfram quota on purely conversational messages."""
    if not user_prompt:
        return False
    lowered = user_prompt.lower()
    math_signals = [
        "calculate", "solve", "integral", "derivative", "equation",
        "simplify", "factor", "evaluate", "convert", "how many",
        "what is the value", "sum of", "limit of", "matrix",
        "+", "-", "*", "/", "^", "=", "sqrt", "log(",
    ]
    return any(signal in lowered for signal in math_signals)


def query_wolfram_alpha(query):
    """Query the Wolfram|Alpha LLM API. Returns plain text result or
    None if the query fails / isn't interpretable. Never raises —
    a Wolfram failure should never break the chat response."""
    if not WOLFRAM_APP_ID or WOLFRAM_APP_ID == "YOUR_WOLFRAM_APPID_HERE":
        return None

    try:
        encoded_query = urllib.parse.quote(query)
        url = f"https://www.wolframalpha.com/api/v1/llm-api?input={encoded_query}&appid={WOLFRAM_APP_ID}"
        response = requests.get(url, timeout=WOLFRAM_TIMEOUT_SECONDS)

        if response.status_code == 200:
            return response.text.strip()
        # 501 = not interpretable, other codes = various failures.
        # Either way, just skip Wolfram for this query rather than erroring.
        return None
    except requests.exceptions.RequestException as e:
        print(f"Wolfram Alpha request failed: {e}")
        return None
    except Exception as e:
        print(f"Wolfram Alpha unexpected error: {e}")
        return None


# ============================================================
# SELF-REVIEW PASS (hallucination-catching second opinion)
# ============================================================
SELF_REVIEW_TIMEOUT_SECONDS = 12


def needs_self_review(user_prompt, wolfram_used):
    """Decide whether a question is the kind where the model could be
    confidently wrong without any external check (fiction/lore/trivia/
    general knowledge) rather than math (already Wolfram-checked) or
    well-established science. Skips review for short/simple messages
    to avoid burning API calls on greetings etc."""
    if wolfram_used:
        return False  # Already cross-checked against a real source
    if not user_prompt or len(user_prompt) < 12:
        return False  # Too short to be a substantive factual claim
    lowered = user_prompt.lower()
    risk_signals = ["who is", "who's", "what is", "what's", "which",
                    "tell me about", "explain the lore", "character",
                    "anime", "movie", "show", "episode", "plot"]
    return any(sig in lowered for sig in risk_signals)


def run_self_review(original_answer, user_prompt):
    """Second Groq call: asks the model to critique its own prior answer
    for unsupported confident claims. Returns a short confidence note,
    or None if review finds nothing worth flagging or fails. This NEVER
    modifies the original answer — it only adds an honest caveat after it,
    since rewriting risks losing content the user already saw stream in."""
    review_prompt = (
        "Here is a question and an AI-generated answer to it.\n\n"
        f"QUESTION: {user_prompt}\n\n"
        f"ANSWER: {original_answer}\n\n"
        "You have no internet access and cannot verify facts in real time. "
        "Review this answer ONLY for specific factual claims (names, abilities, "
        "plot details, dates, niche facts) that you are not highly confident about. "
        "If everything in the answer is something you're confident about, "
        "respond with exactly: CONFIDENT\n"
        "Otherwise, respond with a single short sentence (under 25 words) "
        "naming what specifically might be inaccurate. Do not repeat the "
        "whole answer, just the caveat."
    )
    try:
        if client is None:
            return None
        response = client.chat.completions.create(
            model=GROQ_TEXT_MODEL,
            messages=[{"role": "user", "content": review_prompt}],
            max_tokens=80,
            temperature=0.3,
            stream=False
        )
        review_text = response.choices[0].message.content.strip()

        if not review_text or review_text.upper().startswith("CONFIDENT"):
            return None
        return review_text
    except Exception as e:
        print(f"Self-review pass failed (non-fatal, skipping): {e}")
        return None


# ============================================================
# CHAT HISTORY FILE FUNCTIONS
# ============================================================
def get_chat_filepath(chat_id, device_id):
    """Chat files are namespaced per device: {device_id}__{chat_id}.json
    This is what actually separates one browser's chat list from another's
    — without this, every visitor saw every chat ever created, regardless
    of which device/browser made it."""
    safe_chat_id = "".join([c for c in str(chat_id) if c.isalnum() or c in ("-", "_")])
    safe_device_id = "".join([c for c in str(device_id) if c.isalnum() or c in ("-", "_")])
    return os.path.join(STORAGE_DIR, f"{safe_device_id}__{safe_chat_id}.json")


def read_chat_history(chat_id, device_id):
    path = get_chat_filepath(chat_id, device_id)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error reading history: {e}")
    return []


def save_chat_history(chat_id, device_id, history_data):
    path = get_chat_filepath(chat_id, device_id)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(history_data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving history: {e}")


def get_all_chats_summary(device_id):
    """Returns only chats belonging to this device_id. Filenames not
    matching this device's prefix are invisible to this caller entirely —
    this is what makes the laptop/phone chat-bleeding bug impossible now."""
    chats = []
    if not os.path.exists(STORAGE_DIR):
        return chats
    safe_device_id = "".join([c for c in str(device_id) if c.isalnum() or c in ("-", "_")])
    device_prefix = f"{safe_device_id}__"

    for filename in sorted(os.listdir(STORAGE_DIR), reverse=True):
        if filename.endswith(".json") and filename.startswith(device_prefix):
            # Strip the device prefix and .json suffix to recover the
            # original chat_id the frontend already knows about.
            chat_id = filename[len(device_prefix):-5]
            history = read_chat_history(chat_id, device_id)
            title = "Empty Chat"
            if history:
                meta_block = next((m for m in history if m.get("role") == "metadata"), None)
                if meta_block and meta_block.get("custom_title"):
                    title = meta_block["custom_title"]
                else:
                    first_user = next((m for m in history if m.get("role") == "user"), None)
                    if first_user:
                        raw = first_user.get("content", "")
                        if isinstance(raw, str) and raw:
                            title = raw[:45]
                        else:
                            title = "[Image Analysis]"
            if not title or not isinstance(title, str):
                title = "Untitled Chat"
            chats.append({"id": chat_id, "title": title})
    return chats


# ============================================================
# BUILD GROQ MESSAGE LIST (TEXT-ONLY PATH)
# ============================================================
def build_groq_text_messages(history, user_prompt, chat_id, wolfram_result=None, settings=None):
    """Build the full message list for the text model: system prompt,
    recalled memory, optional Wolfram context, chat history, current turn."""
    messages = [{"role": "system", "content": build_system_prompt(settings or read_settings())}]

    memory_rows = get_memory_context(chat_id)
    if memory_rows:
        memory_lines = [f"{role}: {content}" for role, content in memory_rows]
        memory_text = "\n".join(memory_lines)
        messages.append({
            "role": "system",
            "content": (
                "Relevant memory from earlier in this conversation "
                f"(for context only, do not repeat verbatim):\n{memory_text}"
            )
        })

    if wolfram_result:
        messages.append({
            "role": "system",
            "content": f"Wolfram Alpha computed result for this query:\n{wolfram_result}"
        })

    for msg in history:
        role = msg.get("role")
        if role == "metadata":
            continue
        content = msg.get("content", "")
        if not content or not isinstance(content, str):
            continue
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_prompt})
    return messages


# ============================================================
# BUILD GROQ MESSAGE LIST (VISION PATH)
# ============================================================
def build_groq_vision_messages(user_prompt, image_data_url, settings=None):
    """Vision requests are sent largely standalone — the vision model
    doesn't need full chat history replayed, just the current image +
    question, plus the system prompt for tone/behavior consistency."""
    return [
        {"role": "system", "content": build_system_prompt(settings or read_settings())},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}}
            ]
        }
    ]


# ============================================================
# FLASK ROUTES
# ============================================================
@app.route("/")
def index():
    try:
        with open("index.html", "r", encoding="utf-8") as f:
            return render_template_string(f.read())
    except FileNotFoundError:
        return "Missing index.html file.", 404


@app.route("/<path:filename>")
def serve_root_asset(filename):
    """Serve image/static assets referenced directly by index.html
    (e.g. potato_logo.png) that sit next to app.py rather than in /static."""
    allowed_extensions = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg")
    if filename.lower().endswith(allowed_extensions) and os.path.isfile(filename):
        return send_from_directory(".", filename)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/chats", methods=["GET"])
def api_get_chats():
    existing_id = get_or_assign_device_id()
    device_id = existing_id or str(uuid.uuid4())

    payload = jsonify({"chats": get_all_chats_summary(device_id)})
    response = make_response(payload)
    if not existing_id:
        set_device_cookie(response, device_id)
    return response


@app.route("/api/chats/new", methods=["POST"])
def api_new_chat():
    existing_id = get_or_assign_device_id()
    device_id = existing_id or str(uuid.uuid4())

    new_id = str(uuid.uuid4())
    save_chat_history(new_id, device_id, [])

    response = make_response(jsonify({"chat_id": new_id}))
    if not existing_id:
        set_device_cookie(response, device_id)
    return response


@app.route("/api/chats/load", methods=["POST"])
def api_load_chat():
    existing_id = get_or_assign_device_id()
    device_id = existing_id or str(uuid.uuid4())

    data = request.get_json(silent=True) or {}
    chat_id = data.get("chat_id")
    if not chat_id:
        return jsonify({"error": "Missing chat_id"}), 400

    raw_history = read_chat_history(chat_id, device_id)
    formatted = []
    for msg in raw_history:
        role = msg.get("role")
        if role == "metadata":
            continue
        content = msg.get("content", "")
        if not isinstance(content, str):
            content = "[Image Analysis]"
        formatted.append({"role": role, "content": content})

    response = jsonify({"history": formatted})
    if not existing_id:
        set_device_cookie(response, device_id)
    return response


@app.route("/api/chats/rename", methods=["POST"])
def api_rename_chat():
    existing_id = get_or_assign_device_id()
    device_id = existing_id or str(uuid.uuid4())

    data = request.get_json(silent=True) or {}
    chat_id = data.get("chat_id")
    new_title = str(data.get("title", "")).strip()
    if not chat_id or not new_title:
        return jsonify({"error": "Missing chat_id or title"}), 400

    history = read_chat_history(chat_id, device_id)
    meta_block = next((m for m in history if m.get("role") == "metadata"), None)
    if meta_block:
        meta_block["custom_title"] = new_title
    else:
        history.insert(0, {"role": "metadata", "custom_title": new_title})

    save_chat_history(chat_id, device_id, history)
    response = jsonify({"status": "success"})
    if not existing_id:
        set_device_cookie(response, device_id)
    return response


@app.route("/api/chats/delete", methods=["POST"])
def api_delete_chat():
    existing_id = get_or_assign_device_id()
    device_id = existing_id or str(uuid.uuid4())

    data = request.get_json(silent=True) or {}
    chat_id = data.get("chat_id")
    if chat_id:
        path = get_chat_filepath(chat_id, device_id)
        if os.path.exists(path):
            os.remove(path)
    response = jsonify({"status": "success"})
    if not existing_id:
        set_device_cookie(response, device_id)
    return response


@app.route("/api/chats/export", methods=["POST"])
def api_export_chat():
    """Returns the full raw history for a chat as JSON so the frontend
    can format it into a .txt or .pdf file client-side."""
    existing_id = get_or_assign_device_id()
    device_id = existing_id or str(uuid.uuid4())

    data = request.get_json(silent=True) or {}
    chat_id = data.get("chat_id")
    if not chat_id:
        return jsonify({"error": "Missing chat_id"}), 400

    raw_history = read_chat_history(chat_id, device_id)
    formatted = []
    for msg in raw_history:
        role = msg.get("role")
        if role == "metadata":
            continue
        content = msg.get("content", "")
        if not isinstance(content, str):
            content = "[Image Analysis]"
        formatted.append({"role": role, "content": content})

    chats_summary = get_all_chats_summary(device_id)
    chat_meta = next((c for c in chats_summary if c["id"] == chat_id), None)
    title = chat_meta["title"] if chat_meta else "ProPotato Chat"

    response = jsonify({"title": title, "history": formatted})
    if not existing_id:
        set_device_cookie(response, device_id)
    return response


@app.route("/api/settings", methods=["GET", "POST", "DELETE"])
def api_settings():
    if request.method == "GET":
        return jsonify({"settings": read_settings()})

    if request.method == "DELETE":
        if os.path.exists(SETTINGS_FILE):
            os.remove(SETTINGS_FILE)
        return jsonify({"settings": dict(DEFAULT_SETTINGS)})

    data = request.get_json(silent=True) or {}
    return jsonify({"settings": save_settings(data)})


# ============================================================
# MAIN CHAT ENDPOINT
# ============================================================
@app.route("/chat", methods=["POST"])
def chat_endpoint():
    # ---- RATE LIMITING ----
    client_id = get_client_identifier()
    if is_rate_limited(client_id):
        return jsonify({
            "error": f"Too many requests. Please wait a moment before trying again "
                      f"(limit: {RATE_LIMIT_MAX_REQUESTS} requests per {RATE_LIMIT_WINDOW_SECONDS}s)."
        }), 429

    # ---- DEVICE SCOPING ----
    existing_device_id = get_or_assign_device_id()
    device_id = existing_device_id or str(uuid.uuid4())

    data = request.get_json(silent=True) or {}
    user_prompt = str(data.get("message", "")).strip()
    chat_id = data.get("chat_id")
    image_b64_raw = data.get("image")

    if not chat_id:
        chat_id = str(uuid.uuid4())

    # ---- IMAGE SIZE VALIDATION ----
    image_data_url, base64_data = normalize_image_data_url(image_b64_raw)
    if image_b64_raw and not image_data_url:
        return jsonify({"error": "Invalid image data."}), 400

    if base64_data and len(base64_data) > MAX_IMAGE_BASE64_CHARS:
        return jsonify({
            "error": "Image too large. Please use an image under 6MB."
        }), 400

    if image_data_url and not user_prompt:
        user_prompt = "Please describe and analyze this image in detail."

    if not user_prompt:
        return jsonify({"error": "No message provided"}), 400

    if client is None:
        return jsonify({
            "error": "Server missing GROQ_API_KEY. Set it as an environment variable and restart."
        }), 503

    settings = read_settings()
    history = read_chat_history(chat_id, device_id)

    # Save user message to history (store original prompt text only,
    # not the image data, to keep history files small)
    history.append({"role": "user", "content": user_prompt, "has_image": bool(image_data_url)})
    save_chat_history(chat_id, device_id, history)
    save_to_memory(chat_id, "user", user_prompt)
    prune_old_memory(chat_id)

    past_history = history[:-1]

    # ---- ROUTE TO VISION OR TEXT MODEL ----
    use_vision = bool(image_data_url)
    wolfram_was_used = False

    if use_vision:
        groq_messages = build_groq_vision_messages(user_prompt, image_data_url, settings)
        model_to_use = GROQ_VISION_MODEL
    else:
        wolfram_result = None
        if should_use_wolfram(user_prompt):
            wolfram_result = query_wolfram_alpha(user_prompt)
            wolfram_was_used = wolfram_result is not None
        groq_messages = build_groq_text_messages(past_history, user_prompt, chat_id, wolfram_result, settings)
        model_to_use = GROQ_TEXT_MODEL

    # ---- STREAM RESPONSE ----
    def generate_tokens():
        ai_response_accumulator = ""
        stream_failed = False
        fallback_succeeded = False

        try:
            stream = client.chat.completions.create(
                model=model_to_use,
                messages=groq_messages,
                max_tokens=response_token_limit(settings),
                temperature=0.7,
                stream=True
            )

            for chunk in stream:
                try:
                    token = chunk.choices[0].delta.content
                    if token:
                        ai_response_accumulator += token
                        yield token
                except Exception:
                    continue

        except Exception as e:
            if not use_vision and model_to_use != GROQ_FALLBACK_TEXT_MODEL:
                try:
                    app.logger.warning("Groq model failed: %s. Retrying with %s", model_to_use, GROQ_FALLBACK_TEXT_MODEL)
                    stream = client.chat.completions.create(
                        model=GROQ_FALLBACK_TEXT_MODEL,
                        messages=groq_messages,
                        max_tokens=response_token_limit(settings),
                        temperature=0.7,
                        stream=True
                    )
                    for chunk in stream:
                        try:
                            token = chunk.choices[0].delta.content
                            if token:
                                ai_response_accumulator += token
                                yield token
                        except Exception:
                            continue
                    fallback_succeeded = True
                except Exception:
                    app.logger.exception("Groq fallback stream failed")

            if not fallback_succeeded:
                stream_failed = True
                app.logger.exception("Groq stream failed for model %s", model_to_use)
                error_msg = "\n\n[ProPotato Error: The AI service failed. Please check the model/API key in CMD and try again.]"
                yield error_msg
                ai_response_accumulator += error_msg

        # ---- SELF-REVIEW PASS ----
        # Only runs for non-vision, non-Wolfram-verified answers where
        # hallucination risk is highest (lore/trivia/general knowledge).
        # Failure here is non-fatal and never blocks saving the original answer.
        if not stream_failed and not use_vision and needs_self_review(user_prompt, wolfram_was_used):
            review_note = run_self_review(ai_response_accumulator, user_prompt)
            if review_note:
                caveat = f"\n\n---\n*⚠️ Self-check: {review_note}*"
                ai_response_accumulator += caveat
                yield caveat

        fresh_history = read_chat_history(chat_id, device_id)
        fresh_history.append({"role": "assistant", "content": ai_response_accumulator})
        save_chat_history(chat_id, device_id, fresh_history)

        if not stream_failed:
            save_to_memory(chat_id, "assistant", ai_response_accumulator)

    headers = {"X-Chat-ID": chat_id}
    response = Response(generate_tokens(), mimetype="text/plain", headers=headers)
    if not existing_device_id:
        set_device_cookie(response, device_id)
    return response


# ============================================================
# STARTUP
# ============================================================
if __name__ == "__main__":
    print("=" * 50)
    print("  ProPotato AI Engine v6")
    print(f"  Text Model   : {GROQ_TEXT_MODEL}")
    print(f"  Fallback     : {GROQ_FALLBACK_TEXT_MODEL}")
    print(f"  Vision Model : {GROQ_VISION_MODEL}")
    groq_status = "Configured" if GROQ_API_KEY else "NOT SET"
    wolfram_status = "Configured" if WOLFRAM_APP_ID else "NOT SET"
    print(f"  Groq API Key : {groq_status}")
    print(f"  Wolfram Alpha: {wolfram_status}")
    print("=" * 50)
    print(f"  Memory DB    : {MEMORY_DB}")
    print(f"  Chat Store   : {STORAGE_DIR}/")
    print(f"  Rate Limit   : {RATE_LIMIT_MAX_REQUESTS} req / {RATE_LIMIT_WINDOW_SECONDS}s per IP")
    print(f"  Running at   : http://localhost:5000")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5000, debug=False)
