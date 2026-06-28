import { cleanEnvValue, extractProxySecret } from "./auth.js";

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
  if (cleanEnvValue("CURSORPROXY_API_KEY")) {
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

// Normalize message content to a stable typed array regardless of input format.
// Cursor may mutate content between turns (string -> array of text blocks),
// so raw JSON.stringify produces different hashes.  This extracts the
// semantic content in a format-independent way, preserving enough detail
// that different conversations (different images, different tool calls)
// still produce different keys.
//
// Returns an array of typed objects for JSON.stringify.  This avoids
// structural collisions (e.g. text "I:src:abc" looking like an image block).
//   text / string  -> [{t:"hello"}]
//   image          -> [{i:{u:"url"}}] or [{i:{d:"base64data"}}]
//   tool_use       -> [{u:"name|args"}]
//   tool_result    -> [{r:{id:"...", t:"text"}}]
//   thinking / redacted_thinking -> SKIP (these are what we inject)
function canonicalizeContent(content) {
  if (typeof content === "string") return [{ t: content }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const b of content) {
    if (!b || !b.type) continue;
    if (b.type === "text" && b.text) {
      parts.push({ t: b.text });
    } else if (b.type === "image_url" && b.image_url?.url) {
      // OpenAI vision format: image_url block with URL
      parts.push({ i: { u: b.image_url.url } });
    } else if (b.type === "image") {
      // Anthropic native format: {type:"image", source:{type:"base64",
      //   media_type:"image/png", data:"..."}}
      if (b.source?.data) {
        parts.push({ i: { d: b.source.data } });
      } else if (b.source?.url) {
        parts.push({ i: { u: b.source.url } });
      }
    } else if (b.type === "tool_use") {
      parts.push({ u: (b.name || "") + "|" + JSON.stringify(b.input || {}) });
    } else if (b.type === "tool_result") {
      const tc = typeof b.content === "string"
        ? b.content
        : (Array.isArray(b.content)
          ? b.content
              .filter((c) => c?.type === "text" && c.text)
              .map((c) => c.text)
              .join("\n")
          : "");
      parts.push({ r: { i: b.tool_use_id || "", t: tc } });
    }
    // Skip thinking / redacted_thinking blocks — they are what we inject,
    // not part of conversation identity.
  }
  return parts;
}

// Legacy export for external callers (currently unused from proxy/reasoning
// after normContentLen diagnostic removed, but kept for API stability).
export function normalizeContent(content) {
  const parts = canonicalizeContent(content);
  return parts.map((p) => {
    if (p.t) return p.t;
    if (p.i) return "I:" + (p.i.u || p.i.d || "");
    if (p.u) return "U:" + p.u;
    if (p.r) return "R:" + p.r.i + "|" + (p.r.t || "");
    return "";
  }).join("\n");
}

// Hash messages up to index `upTo` after normalizing each message to
// { role, c, tools }.  Tool calls, image identity, and tool_use blocks
// are preserved because they distinguish conversations.  Format wrappers,
// thinking blocks, and volatile Cursor metadata are stripped so the key
// is stable across turns.  Content is a typed array of {t, i, u, r} objects
// so JSON.stringify produces unambiguous output — no structural collisions
// between text content and block markers.
// Key prefix is "asst:" (distinct from "conv:" used by the reasoning bridge).
export async function normalizedConversationHash(messages, upTo, scope, keyPrefix = "asst:") {
  const prefix = messages.slice(0, upTo).map((m) => ({
    r: m.role || "?",
    c: canonicalizeContent(m.content),
    // OpenAI-format tool_calls live outside content; preserve name+args
    ...(Array.isArray(m.tool_calls) && m.tool_calls.length > 0
      ? { t: m.tool_calls.map((tc) => (tc.function?.name || "") + "|" + (tc.function?.arguments || "")) }
      : {}),
    // Chat Completions tool-result messages carry identity in tool_call_id
    ...(m.role === "tool" && m.tool_call_id
      ? { tid: m.tool_call_id }
      : {}),
  }));
  return sha256Prefix(scope + ":" + JSON.stringify(prefix), keyPrefix);
}
