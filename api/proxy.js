export const config = { runtime: "edge" };

import { kvGet, kvSet } from "./kv.js";

const DEBUG = process.env.DEBUG === "true";

const PROVIDERS = {
  deepseek: {
    url: process.env.UPSTREAM_DEEPSEEK || "https://api.deepseek.com",
    host: "api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  kimi: {
    url: process.env.UPSTREAM_KIMI || "https://api.moonshot.ai",
    host: "api.moonshot.ai",
    apiKeyEnv: "KIMI_API_KEY",
  },
  minimax: {
    url: process.env.UPSTREAM_MINIMAX || "https://api.minimax.io",
    host: "api.minimax.io",
    apiKeyEnv: "MINIMAX_API_KEY",
  },
};

function log(...args) {
  if (DEBUG) console.log("[cursorProxy]", ...args);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function extractProxySecret(req) {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const xk = req.headers.get("x-api-key");
  if (xk) return xk.trim();
  return null;
}

function jsonErrorResponse(status, message, code, type = "invalid_request_error") {
  return new Response(
    JSON.stringify({
      error: { message, type, code },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

/** If CURSORPROXY_API_KEY is set, require Bearer or x-api-key match. */
function checkProxyAuth(req) {
  const required = process.env.CURSORPROXY_API_KEY;
  if (!required) return null;
  const secret = extractProxySecret(req);
  if (!secret || !timingSafeEqualStr(secret, required)) {
    return jsonErrorResponse(
      401,
      "Incorrect API key provided.",
      "invalid_api_key",
      "invalid_request_error"
    );
  }
  return null;
}

function providerFromModel(model) {
  if (typeof model !== "string" || !model) return null;
  const m = model.toLowerCase();
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("kimi")) return "kimi";
  if (m.startsWith("deepseek")) return "deepseek";
  return null;
}

function upstreamApiKey(providerKey) {
  const meta = PROVIDERS[providerKey] ?? PROVIDERS.deepseek;
  return process.env[meta.apiKeyEnv] || "";
}

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

async function cacheScopeUserId(req) {
  if (process.env.CURSORPROXY_API_KEY) {
    const t = extractProxySecret(req);
    return apiKeyHash(t ? `Bearer ${t}` : "");
  }
  return apiKeyHash(null);
}

// Hash all messages BEFORE index `upTo` to identify a conversation turn.
// scope = "<providerKey>:<apiKeyHash>" prevents cross-provider and cross-user cache collisions.
async function conversationHash(messages, upTo, scope) {
  const prefix = messages.slice(0, upTo);
  return sha256Prefix(scope + ":" + JSON.stringify(prefix), "conv:");
}

function stripReasoning(obj) {
  if (!obj) return obj;
  const { reasoning_content, ...rest } = obj;
  return rest;
}

function stripResponseChunk(json) {
  if (!json.choices) return json;
  return {
    ...json,
    choices: json.choices.map((c) => ({
      ...c,
      ...(c.message ? { message: stripReasoning(c.message) } : {}),
      ...(c.delta ? { delta: stripReasoning(c.delta) } : {}),
    })),
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req) {
  const authErr = checkProxyAuth(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const pathname = url.pathname;
  const searchParams = new URLSearchParams(url.search);

  let providerKey = searchParams.get("provider");
  const pathParam = searchParams.get("path") || "";

  log("START", req.method, req.url, "pathname:", pathname, "provider(query):", providerKey || "(infer)");

  // Parse body early for model-based routing (unified /v1 without provider query)
  let bodyText = "";
  let parsedBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyText = await req.text();
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {}
  }

  if (!providerKey) {
    providerKey = providerFromModel(parsedBody?.model);
  }
  if (!providerKey) {
    providerKey = "deepseek";
  }

  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerKey)) {
    return jsonErrorResponse(
      400,
      `Unknown provider "${providerKey}". Use deepseek, kimi, or minimax (or set model to a matching provider prefix).`,
      "unknown_provider",
      "invalid_request_error"
    );
  }

  const provider = PROVIDERS[providerKey];
  const providerSecret = upstreamApiKey(providerKey);
  if (!providerSecret) {
    return jsonErrorResponse(
      503,
      `Missing environment variable ${provider.apiKeyEnv} for provider "${providerKey}".`,
      "provider_key_missing",
      "api_error"
    );
  }

  // Docker / local Node: one access line without DEBUG (Vercel Edge skips to avoid noise)
  if (!process.env.VERCEL) {
    const modelName =
      typeof parsedBody?.model === "string" ? parsedBody.model : "-";
    console.log(
      `[cursorProxy] ${req.method} /v1/${pathParam} provider=${providerKey} model=${modelName}`
    );
  }

  // Clean up Vercel rewrite query pollution
  searchParams.delete("path");
  searchParams.delete("provider");

  const queryString = searchParams.toString()
    ? "?" + searchParams.toString()
    : "";
  const upstreamUrl = provider.url + "/v1/" + pathParam + queryString;
  log("UPSTREAM", upstreamUrl, "provider:", providerKey);

  const originalMessages = parsedBody?.messages ? [...parsedBody.messages] : null;

  const scopeUser = await cacheScopeUserId(req);
  const scope = providerKey + ":" + scopeUser;

  // Inject stored reasoning_content into ALL assistant messages by position
  let injectedCount = 0;
  if (originalMessages) {
    const messages = parsedBody.messages;
    const assistantIndices = messages
      .map((m, i) => i)
      .filter((i) => messages[i].role === "assistant" && !("reasoning_content" in messages[i]));

    const fetched = await Promise.all(
      assistantIndices.map(async (i) => {
        const key = await conversationHash(originalMessages, i, scope);
        const stored = await kvGet(key);
        log("INJECT idx:", i, "key:", key, "hit:", stored != null);
        return { i, stored };
      })
    );

    for (const { i, stored } of fetched) {
      if (stored != null) {
        messages[i] = { ...messages[i], reasoning_content: stored };
        injectedCount++;
      }
    }
    bodyText = JSON.stringify(parsedBody);
  }
  log("INJECTED", injectedCount, "/", originalMessages?.filter((m) => m.role === "assistant").length || 0);

  const headers = new Headers(req.headers);
  headers.set("host", provider.host);
  headers.set("authorization", "Bearer " + providerSecret);
  headers.delete("x-api-key");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("accept-encoding");
  headers.set("accept-encoding", "identity");

  let upstreamRes;
  const connectController = process.env.VERCEL ? new AbortController() : null;
  const connectTimer = connectController
    ? setTimeout(() => connectController.abort(), 15000)
    : null;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyText || null,
      ...(connectController ? { signal: connectController.signal } : {}),
    });
    if (connectTimer) clearTimeout(connectTimer);
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    log("UPSTREAM_ERROR", err?.name, err?.message);
    return new Response(
      JSON.stringify({
        error: {
          message: isTimeout
            ? "Upstream provider timed out (>15s connecting)"
            : `Upstream fetch failed: ${err?.message}`,
          type: "upstream_error",
          code: isTimeout ? "upstream_timeout" : "upstream_fetch_error",
        },
      }),
      {
        status: 504,
        headers: { "content-type": "application/json" },
      }
    );
  }

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isStream = contentType.includes("text/event-stream");
  log("UPSTREAM_STATUS", upstreamRes.status, "provider:", providerKey, "stream:", isStream);

  if (!isStream) {
    const text = await upstreamRes.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return new Response(text, {
        status: upstreamRes.status,
        headers: { "content-type": contentType || "text/plain" },
      });
    }

    const reasoning = json.choices?.[0]?.message?.reasoning_content;
    if (reasoning != null && originalMessages) {
      const key = await conversationHash(originalMessages, originalMessages.length, scope);
      log("CACHE non-stream key:", key);
      await kvSet(key, reasoning);
    }
    return new Response(JSON.stringify(stripResponseChunk(json)), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = upstreamRes.body.getReader();
    let buffer = "";
    let accReasoning = "";
    let accContent = "";
    let doneSeen = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) {
            if (line.trim()) await writer.write(encoder.encode(line + "\n"));
            continue;
          }

          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            doneSeen = true;
            log("STREAM_DONE", "reasoning:", accReasoning.length, "content:", accContent.length);
            if (originalMessages && (accReasoning.length > 0 || accContent.length > 0)) {
              const key = await conversationHash(originalMessages, originalMessages.length, scope);
              log("CACHE stream key:", key);
              await kvSet(key, accReasoning);
            }
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta?.reasoning_content) accReasoning += delta.reasoning_content;
            if (delta?.content != null) accContent += delta.content;
            await writer.write(
              encoder.encode(
                "data: " + JSON.stringify(stripResponseChunk(json)) + "\n\n"
              )
            );
          } catch {
            await writer.write(encoder.encode(line + "\n\n"));
          }
        }
      }
    } finally {
      if (!doneSeen && originalMessages && (accReasoning.length > 0 || accContent.length > 0)) {
        log("STREAM_FINALLY", "reasoning:", accReasoning.length, "content:", accContent.length);
        const key = await conversationHash(originalMessages, originalMessages.length, scope);
        log("CACHE finally key:", key);
        await kvSet(key, accReasoning);
      }
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: upstreamRes.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
