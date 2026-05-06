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
