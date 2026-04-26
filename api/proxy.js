export const config = { runtime: "edge" };

import { kvGet, kvSet } from "./kv.js";

const DEBUG = process.env.DEBUG === "true";

const PROVIDERS = {
  deepseek: {
    url:  process.env.UPSTREAM_DEEPSEEK || "https://api.deepseek.com",
    host: "api.deepseek.com",
  },
  kimi: {
    url:  process.env.UPSTREAM_KIMI || "https://api.moonshot.ai",
    host: "api.moonshot.ai",
  },
  minimax: {
    url:  process.env.UPSTREAM_MINIMAX || "https://api.minimax.io",
    host: "api.minimax.io",
  },
};

function log(...args) {
  if (DEBUG) console.log("[cursorProxy]", ...args);
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

// Short stable hash of the API key — isolates cache per user
async function apiKeyHash(authHeader) {
  if (!authHeader) return "anon";
  const data = new TextEncoder().encode(authHeader);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
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
  const url = new URL(req.url);
  let pathname = url.pathname;
  const searchParams = new URLSearchParams(url.search);

  // Resolve provider from rewrite query param (default: deepseek for legacy /v1/ path)
  const providerKey = searchParams.get("provider") || "deepseek";
  const provider = PROVIDERS[providerKey] ?? PROVIDERS.deepseek;

  // path param is the portion after /v1/ captured by the vercel.json rewrite
  const pathParam = searchParams.get("path") || "";

  log("START", req.method, req.url, "pathname:", pathname, "provider:", providerKey);

  // Clean up Vercel rewrite query pollution
  searchParams.delete("path");
  searchParams.delete("provider");

  const queryString = searchParams.toString()
    ? "?" + searchParams.toString()
    : "";
  // Reconstruct correct upstream path from the captured path param
  const upstreamUrl = provider.url + "/v1/" + pathParam + queryString;
  log("UPSTREAM", upstreamUrl);

  // Parse body
  let bodyText = "";
  let parsedBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyText = await req.text();
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {}
  }

  const originalMessages = parsedBody?.messages ? [...parsedBody.messages] : null;

  // scope = provider + user (API key hash) — prevents cross-provider and cross-user cache collisions
  const scope = providerKey + ":" + await apiKeyHash(req.headers.get("authorization"));

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
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("accept-encoding");
  headers.set("accept-encoding", "identity");

  let upstreamRes;
  // On Vercel, apply a 15s connection timeout so we return a clean 504 before
  // the platform kills the function. On Docker (no VERCEL env), no timeout.
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

  // ─── Non-streaming response ──────────────────────────────────────────────
  if (!isStream) {
    const text = await upstreamRes.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Pass through non-JSON errors
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

  // ─── Streaming response ──────────────────────────────────────────────────
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
      // Cache even if stream closed without explicit [DONE]
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
