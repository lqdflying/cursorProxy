export const config = { runtime: "edge" };

import { kvGet, kvSet } from "./kv.js";
import { describeImage } from "./vision.js";

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

/** Always-on warning for critical diagnostic events (not gated by DEBUG). */
function warn(...args) {
  console.log("[cursorProxy]", ...args);
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

// Hash image content (data URI or URL) for vision description caching
async function sha256ImageHash(dataUri) {
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

/**
 * Convert image content to text descriptions using the configured vision API.
 * Caches descriptions by image hash in KV to avoid re-processing.
 *
 * @param {Array} messages - The messages array from the request body.
 * @returns {Promise<{messages: Array, convertedCount: number, errors: number}>}
 */
async function convertImagesToText(messages) {
  let convertedCount = 0;
  let errors = 0;

  // Flatten all image_url parts to process them in parallel
  const imageTasks = [];
  const replacements = []; // { msgIdx, partIdx, imageUrl }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" && m.role !== "system") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;

    for (let j = 0; j < content.length; j++) {
      const part = content[j];
      if (part?.type !== "image_url") continue;

      const imageUrl = part.image_url?.url;
      if (!imageUrl) continue;

      replacements.push({ msgIdx: i, partIdx: j, imageUrl });
    }
  }

  if (replacements.length === 0) {
    return { messages, convertedCount: 0, errors: 0 };
  }

  // Process all images in parallel with cache lookups
  const results = await Promise.all(
    replacements.map(async ({ msgIdx, partIdx, imageUrl }) => {
      try {
        // Check KV cache first
        const cacheKey = await sha256ImageHash(imageUrl);
        const cached = await kvGet(cacheKey);
        if (cached) {
          return { msgIdx, partIdx, description: cached, fromCache: true };
        }

        // Call vision API
        const description = await describeImage(imageUrl);
        if (description) {
          // Cache the result (silent failure on cache write is fine)
          await kvSet(cacheKey, description).catch(() => {});
        }
        return { msgIdx, partIdx, description, fromCache: false };
      } catch (err) {
        log("VISION_ERROR", err.message);
        return { msgIdx, partIdx, description: null, error: err.message };
      }
    })
  );

  // Apply replacements to a mutable copy of messages
  const updated = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));

  for (const r of results) {
    const { msgIdx, partIdx, description, error } = r;
    if (description) {
      updated[msgIdx].content[partIdx] = {
        type: "text",
        text: "[Image content: " + description + "]",
      };
      convertedCount++;
      log("VISION_CONVERTED", "msg:", msgIdx, "part:", partIdx, "cached:", r.fromCache);
    } else {
      updated[msgIdx].content[partIdx] = {
        type: "text",
        text: "[Image content — vision description unavailable" + (error ? ": " + error : "") + "]",
      };
      errors++;
    }
  }

  // If a message ends up with no text parts after conversion, add a placeholder
  for (let i = 0; i < updated.length; i++) {
    const m = updated[i];
    if (!Array.isArray(m.content)) continue;
    if (m.content.length === 0) {
      m.content = "[Image content removed — this model does not support vision inputs.]";
    }
    // Compact: merge consecutive text parts
    const hasText = m.content.some((p) => p?.type === "text" || typeof p === "string");
    const hasImages = m.content.some((p) => p?.type === "image_url");
    if (!hasText && !hasImages) {
      m.content = "[Message contained only non-vision content]";
    }
  }

  return { messages: updated, convertedCount, errors };
}

// ─── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req) {
  const t0 = Date.now();
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
    } catch {
      warn("BODY_PARSE_ERROR", "bodyLength:", bodyText.length, "firstChars:", bodyText.slice(0, 200));
    }
  }

  if (!providerKey) {
    providerKey = providerFromModel(parsedBody?.model);
  }
  if (!providerKey) {
    providerKey = "deepseek";
  }

  log("RESOLVED", "model:", parsedBody?.model || "(none)", "provider:", providerKey, "stream:", parsedBody?.stream);

  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerKey)) {
    warn("UNKNOWN_PROVIDER", "model:", parsedBody?.model, "provider:", providerKey);
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
        return { i, stored, key };
      })
    );

    for (const { i, stored, key } of fetched) {
      if (stored != null) {
        messages[i] = { ...messages[i], reasoning_content: stored };
        injectedCount++;
      } else {
        warn("INJECT_MISS", "idx:", i, "key:", key,
             "msgPreview:", messages[i].content?.slice?.(0, 60) || "(no content)");
      }
    }
    bodyText = JSON.stringify(parsedBody);
  }
  log("INJECTED", injectedCount, "/", originalMessages?.filter((m) => m.role === "assistant").length || 0);

  // Convert images to text for providers that don't support vision inputs
  // DeepSeek and MiniMax chat endpoints do not accept inline image_url content.
  // The vision API (MiniMax VL-01 by default) is called to describe images,
  // and the descriptions are injected as text before forwarding.
  const providersWithoutVision = ["deepseek", "minimax"];
  if (providersWithoutVision.includes(providerKey) && parsedBody?.messages) {
    const {
      messages: convertedMessages,
      convertedCount,
      errors,
    } = await convertImagesToText(parsedBody.messages);
    if (convertedCount > 0) {
      parsedBody.messages = convertedMessages;
      bodyText = JSON.stringify(parsedBody);
      log(
        "CONVERTED_IMAGES",
        convertedCount,
        "for provider:",
        providerKey,
        "errors:",
        errors
      );
    }
  }

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

  // Log upstream errors with full response body for debugging (always-on)
  if (upstreamRes.status >= 400) {
    const cloned = upstreamRes.clone();
    const errText = await cloned.text().catch(() => "(unreadable)");
    warn("UPSTREAM_ERROR_STATUS", upstreamRes.status, "provider:", providerKey, "body:", errText);
  }

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
    log("NONSTREAM_DONE", "choices:", json.choices?.length, "reasoning_chars:", reasoning?.length || 0);
    return new Response(JSON.stringify(stripResponseChunk(json)), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Streaming timeout: defaults to 280s on Vercel (under the 300s limit) or 0 (disabled)
  // Also clamps to remaining Vercel budget so pre-stream work doesn't eat into the 300s wall.
  const streamTimeoutSec = parseInt(process.env.STREAM_TIMEOUT_SECONDS || "", 10);
  const elapsedSec = (Date.now() - t0) / 1000;
  const platformLimit = process.env.VERCEL ? 295 : Infinity;
  const maxStreamSec = platformLimit - elapsedSec - 5; // 5s safety margin
  const effectiveTimeoutSec = streamTimeoutSec > 0
    ? Math.min(streamTimeoutSec, maxStreamSec)
    : (process.env.VERCEL ? Math.min(280, maxStreamSec) : 0);

  log("STREAM_START", "timeout:", effectiveTimeoutSec > 0 ? effectiveTimeoutSec + "s" : "none",
      "provider:", providerKey);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const reader = upstreamRes.body.getReader();
  let timedOut = false;
  let streamTimer = null;

  if (effectiveTimeoutSec > 0) {
    streamTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, effectiveTimeoutSec * 1000);
  }

  (async () => {
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
            if (accReasoning.length > 5000 && accContent.length < 100) {
              log("LOW_CONTENT_WARNING", "reasoning:", accReasoning.length, "content:", accContent.length);
            }
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
      if (streamTimer) clearTimeout(streamTimer);

      if (timedOut) {
        warn("STREAM_TIMEOUT", "reasoning:", accReasoning.length, "content:", accContent.length,
            "timeout:", effectiveTimeoutSec + "s");
        if (accReasoning.length > 5000 && accContent.length < 100) {
          warn("LOW_CONTENT_WARNING", "reasoning:", accReasoning.length, "content:", accContent.length);
        }
        try {
          const timeoutMsg = JSON.stringify({
            error: {
              message: `Stream timed out after ${effectiveTimeoutSec}s. The model was still generating (reasoning: ${accReasoning.length} chars, content: ${accContent.length} chars). Retry with a smaller prompt, or increase STREAM_TIMEOUT_SECONDS.`,
              type: "stream_timeout",
              code: "stream_timeout",
            },
          });
          await writer.write(encoder.encode("data: " + timeoutMsg + "\n\n"));
        } catch {}
      }

      if (!doneSeen && !timedOut && originalMessages && (accReasoning.length > 0 || accContent.length > 0)) {
        warn("STREAM_FINALLY", "reasoning:", accReasoning.length, "content:", accContent.length);
        if (accReasoning.length > 5000 && accContent.length < 100) {
          warn("LOW_CONTENT_WARNING", "reasoning:", accReasoning.length, "content:", accContent.length);
        }
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
