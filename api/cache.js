import { extractProxySecret } from "./auth.js";

async function sha256Prefix(text, prefix) {
  const data = new TextEncoder().encode(String(text));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return (
    prefix +
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 40)
  );
}

// Hash image content (data URI or URL) for vision description caching
export async function sha256ImageHash(dataUri) {
  const data = new TextEncoder().encode(dataUri);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return "img:" + Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 40);
}

// Short stable hash — isolates cache per proxy client (or anon when no proxy key configured)
async function apiKeyHash(authHeader) {
  if (!authHeader) return "anon";
  const data = new TextEncoder().encode(authHeader);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
}

export async function cacheScopeUserId(req) {
  if (process.env.CURSORPROXY_API_KEY) {
    const t = extractProxySecret(req);
    return apiKeyHash(t ? `Bearer ${t}` : "");
  }
  return apiKeyHash(null);
}

// Hash all messages BEFORE index `upTo` to identify a conversation turn.
// scope = "<providerKey>:<apiKeyHash>" prevents cross-provider and cross-user cache collisions.
export async function conversationHash(messages, upTo, scope) {
  const prefix = messages.slice(0, upTo);
  return sha256Prefix(scope + ":" + JSON.stringify(prefix), "conv:");
}

// Normalize message content to a stable string regardless of input format.
// Cursor may mutate content between turns (string -> array of text blocks),
// so raw JSON.stringify produces different hashes.  This extracts the
// semantic content in a format-independent way, preserving enough detail
// that different conversations (different images, different tool calls)
// still produce different keys.
//
// For array content blocks:
//   text        -> "T:" + text
//   image_url   -> "I:" + url
//   tool_use    -> "U:" + name + "|" + JSON.stringify(input)
//   tool_result -> "R:" + tool_use_id + "|" + normalized content text
//   thinking / redacted_thinking -> SKIP (these are what we inject)
export function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b || !b.type) continue;
      if (b.type === "text" && b.text) {
        parts.push("T:" + b.text);
      } else if ((b.type === "image_url" || b.type === "image") && b.image_url?.url) {
        parts.push("I:" + b.image_url.url);
      } else if (b.type === "tool_use") {
        parts.push("U:" + (b.name || "") + "|" + JSON.stringify(b.input || {}));
      } else if (b.type === "tool_result") {
        const tc = typeof b.content === "string"
          ? b.content
          : (Array.isArray(b.content)
            ? b.content
                .filter((c) => c?.type === "text" && c.text)
                .map((c) => c.text)
                .join("\n")
            : "");
        parts.push("R:" + (b.tool_use_id || "") + "|" + tc);
      }
      // Skip thinking / redacted_thinking blocks — they are what we inject,
      // not part of conversation identity.
    }
    return parts.join("\n");
  }
  return "";
}

// Hash messages up to index `upTo` after normalizing each message to
// { role, content, tools }.  Tool calls, image URLs, and tool_use blocks
// are preserved because they distinguish conversations.  Format wrappers,
// thinking blocks, and volatile Cursor metadata are stripped so the key
// is stable across turns.
// Key prefix is "asst:" (distinct from "conv:" used by the reasoning bridge).
export async function normalizedConversationHash(messages, upTo, scope) {
  const prefix = messages.slice(0, upTo).map((m) => ({
    role: m.role || "unknown",
    content: normalizeContent(m.content),
    // OpenAI-format tool_calls live outside content; preserve name+args
    ...(Array.isArray(m.tool_calls) && m.tool_calls.length > 0
      ? { tools: m.tool_calls.map((t) => (t.function?.name || "") + "|" + (t.function?.arguments || "")) }
      : {}),
  }));
  return sha256Prefix(scope + ":" + JSON.stringify(prefix), "asst:");
}
