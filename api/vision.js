// ─── Image-to-Text Bridge ───────────────────────────────────────────────────
// Converts base64 image_url content blocks to text descriptions before
// forwarding to text-only models (DeepSeek, MiniMax chat).
//
// Supports backends:
//   1. minimax_vl  — MiniMax VL-01 via /v1/coding_plan/vlm (default)
//   2. openai      — Any OpenAI-compatible vision endpoint
//
// Edge Runtime safe: uses only fetch() and crypto.subtle (no Node.js APIs).

const DEBUG = process.env.DEBUG === "true";

function log(...args) {
  // Verbose debug logs — only on Docker/local deploys, never on Vercel Edge.
  if (DEBUG && !process.env.VERCEL) console.log("[cursorProxy:vision]", ...args);
}

// ─── Configuration ──────────────────────────────────────────────────────────

const PROVIDER = process.env.VISION_API_PROVIDER || "minimax_vl";

const CONFIG = {
  minimax_vl: {
    url: process.env.VISION_API_URL || "https://api.minimax.io/v1/coding_plan/vlm",
    host: "api.minimax.io",
    model: process.env.VISION_MODEL || "MiniMax-VL-01",
    apiKeyEnv: "MINIMAX_API_KEY",
  },
  openai: {
    url: process.env.VISION_API_URL || "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com",
    model: process.env.VISION_MODEL || "gpt-4o-mini",
    apiKeyEnv: "VISION_API_KEY",
  },
};

function apiKey() {
  const cfg = CONFIG[PROVIDER];
  if (!cfg) return "";
  return process.env[cfg.apiKeyEnv] || "";
}

// Per-image vision call timeout. Vercel kills the function at 25s if no
// initial Response has been returned, so a stuck vision call could block
// the entire request. Default 15s; override via VISION_TIMEOUT_MS.
// Set VISION_TIMEOUT_MS=0 to disable (e.g. for Docker where there is no
// platform-imposed wall-clock limit).
function visionTimeoutMs() {
  const raw = process.env.VISION_TIMEOUT_MS;
  if (raw == null || raw === "") return 15000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 15000;
  return n; // 0 = disabled
}

async function fetchWithTimeout(url, init) {
  const ms = visionTimeoutMs();
  if (ms === 0) {
    return fetch(url, init);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`vision request timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Backends ───────────────────────────────────────────────────────────────

async function describeWithMinimaxVl(base64Uri, prompt) {
  const cfg = CONFIG.minimax_vl;
  const key = apiKey();
  if (!key) throw new Error("Missing MINIMAX_API_KEY for vision");

  const body = JSON.stringify({
    model: cfg.model,
    image_url: base64Uri,
    prompt: prompt || "Describe this image in detail",
  });

  log("minimax_vl request", cfg.url, "size:", body.length);

  const res = await fetchWithTimeout(cfg.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `MiniMax VL error ${res.status}: ${json.base_resp?.status_msg || json.error?.message || JSON.stringify(json)}`
    );
  }

  const description = json.content;
  if (typeof description !== "string") {
    throw new Error(`MiniMax VL unexpected response: ${JSON.stringify(json)}`);
  }

  log("minimax_vl response", description.slice(0, 120) + "...");
  return description;
}

async function describeWithOpenAi(base64Uri, prompt) {
  const cfg = CONFIG.openai;
  const key = apiKey();
  if (!key) throw new Error("Missing VISION_API_KEY for OpenAI vision");

  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt || "Describe this image in detail",
          },
          {
            type: "image_url",
            image_url: { url: base64Uri },
          },
        ],
      },
    ],
    max_tokens: 2048,
  });

  log("openai request", cfg.url, "size:", body.length);

  const res = await fetchWithTimeout(cfg.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `OpenAI vision error ${res.status}: ${json.error?.message || JSON.stringify(json)}`
    );
  }

  const description = json.choices?.[0]?.message?.content;
  if (typeof description !== "string") {
    throw new Error(`OpenAI vision unexpected response: ${JSON.stringify(json)}`);
  }

  log("openai response", description.slice(0, 120) + "...");
  return description;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a base64 image data URI to a text description.
 * @param {string} base64Uri - e.g. "data:image/png;base64,iVBORw0KGgo..."
 * @param {string} [prompt] - Optional custom prompt for the vision model
 * @returns {Promise<string>} - Text description of the image
 */
export async function describeImage(base64Uri, prompt) {
  switch (PROVIDER) {
    case "minimax_vl":
      return describeWithMinimaxVl(base64Uri, prompt);
    case "openai":
      return describeWithOpenAi(base64Uri, prompt);
    default:
      throw new Error(`Unknown VISION_API_PROVIDER: ${PROVIDER}`);
  }
}

// NOTE: convertImagesToText lives in api/proxy.js (it depends on KV caching and
// per-image SHA-256 hashing wired up there). Only describeImage is exported
// from this module to keep a single source of truth.
