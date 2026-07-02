const OPENAICOMPAT_CACHE_HIT_MODES = new Set(["default", "sub2api"]);
const OPENAICOMPAT_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function trimLower(value) {
  return String(value || "").trim().toLowerCase();
}

function envValue(name) {
  const value = process.env[name];
  if (value == null) return "";
  return String(value).trim();
}

export function openAICompatCacheHitMode() {
  const raw = trimLower(process.env.OPENAICOMPAT_CACHE_HIT_MODE || "default");
  return OPENAICOMPAT_CACHE_HIT_MODES.has(raw) ? raw : "default";
}

export function isOpenAICompatSub2ApiCacheMode() {
  return openAICompatCacheHitMode() === "sub2api";
}

export function shouldAutoInjectPromptCacheKeyForCompat(model) {
  const normalized = trimLower(model);
  return normalized.includes("gpt-5") || normalized.includes("codex");
}

function canonicalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = canonicalize(value[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function normalizeCompatSeedJSON(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(canonicalize(value));
  } catch {
    return String(value);
  }
}

async function sha256Hex(text, length = 32) {
  const data = new TextEncoder().encode(String(text));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function effectiveReasoningEffort(parsedBody) {
  const envEffort = trimLower(envValue("OPENAICOMPAT_REASONING_EFFORT"));
  if (OPENAICOMPAT_REASONING_EFFORTS.has(envEffort)) return envEffort;
  const nested = parsedBody?.reasoning?.effort;
  if (nested != null && String(nested).trim() !== "") return String(nested).trim();
  const flat = parsedBody?.reasoning_effort;
  if (flat != null && String(flat).trim() !== "") return String(flat).trim();
  return "";
}

function firstUserContentFromInput(input) {
  if (typeof input === "string") return { label: "input", value: input };
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.role === "user") return { label: "first_user", value: item.content };
    if (item.type === "input_text") return { label: "first_user", value: item.text || "" };
    if (item.type === "message" && item.role === "user") return { label: "first_user", value: item.content };
  }
  return null;
}

function appendStableSeedParts(parts, parsedBody, model) {
  const normalizedModel = String(model || parsedBody?.model || "").trim();
  if (normalizedModel) parts.push("model=" + normalizedModel);

  const effort = effectiveReasoningEffort(parsedBody);
  if (effort) parts.push("reasoning_effort=" + effort);

  if (parsedBody?.tool_choice != null) {
    parts.push("tool_choice=" + normalizeCompatSeedJSON(parsedBody.tool_choice));
  }
  if (Array.isArray(parsedBody?.tools) && parsedBody.tools.length > 0) {
    parts.push("tools=" + normalizeCompatSeedJSON(parsedBody.tools));
  }
  if (Array.isArray(parsedBody?.functions) && parsedBody.functions.length > 0) {
    parts.push("functions=" + normalizeCompatSeedJSON(parsedBody.functions));
  }
  if (typeof parsedBody?.instructions === "string" && parsedBody.instructions) {
    parts.push("instructions=" + parsedBody.instructions);
  }

  let firstUserCaptured = false;
  if (Array.isArray(parsedBody?.messages)) {
    for (const msg of parsedBody.messages) {
      const role = String(msg?.role || "").trim();
      if (role === "system" || role === "developer") {
        parts.push(role + "=" + normalizeCompatSeedJSON(msg.content));
      } else if (role === "user" && !firstUserCaptured) {
        parts.push("first_user=" + normalizeCompatSeedJSON(msg.content));
        firstUserCaptured = true;
      }
    }
  } else {
    if (Array.isArray(parsedBody?.input)) {
      for (const item of parsedBody.input) {
        const role = String(item?.role || "").trim();
        if (role === "system" || role === "developer") {
          parts.push(role + "=" + normalizeCompatSeedJSON(item.content));
        }
      }
    }
    const firstInput = firstUserContentFromInput(parsedBody?.input);
    if (firstInput) {
      parts.push(firstInput.label + "=" + normalizeCompatSeedJSON(firstInput.value));
    }
  }

  return parts;
}

export async function deriveCompatPromptCacheKey(parsedBody, model) {
  if (!parsedBody || !shouldAutoInjectPromptCacheKeyForCompat(model || parsedBody.model)) {
    return "";
  }
  const seedParts = appendStableSeedParts([], parsedBody, model);
  if (seedParts.length === 0) return "";
  return "compat_cc_" + await sha256Hex(seedParts.join("|"), 32);
}

export async function deriveOpenAIContentSessionSeed(parsedBody, model) {
  if (!parsedBody) return "";
  const seedParts = appendStableSeedParts([], parsedBody, model);
  if (seedParts.length === 0) return "";
  return "compat_cs_" + await sha256Hex(seedParts.join("|"), 32);
}

export async function deriveOpenAICompatSessionAnchor(req, parsedBody, model) {
  const sessionId = req?.headers?.get("session_id")?.trim();
  if (sessionId) return "session_id_" + await sha256Hex(sessionId, 32);
  const conversationId = req?.headers?.get("conversation_id")?.trim();
  if (conversationId) return "conversation_id_" + await sha256Hex(conversationId, 32);
  const promptCacheKey = String(parsedBody?.prompt_cache_key || "").trim();
  if (promptCacheKey) return "prompt_cache_key_" + await sha256Hex(promptCacheKey, 32);
  return deriveOpenAIContentSessionSeed(parsedBody, model);
}
