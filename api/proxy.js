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
  if (DEBUG) console.log("[cursorProxy:proxy]", ...args);
}

function diag(...args) {
  console.log("[cursorProxy:proxy]", ...args);
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

function configuredModelIds() {
  const raw = process.env.CURSORPROXY_MODELS || "";
  const seen = new Set();
  const models = [];

  for (const value of raw.split(/[,\r\n]+/)) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }

  return models;
}

function isModelDiscoveryRequest(req, pathname, pathParam) {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const normalizedPathParam = pathParam.replace(/^\/+|\/+$/g, "");
  return normalizedPathParam === "models" || pathname === "/v1/models";
}

function modelDiscoveryResponse(req) {
  const body = JSON.stringify({
    object: "list",
    data: configuredModelIds().map((id) => ({
      id,
      object: "model",
      owned_by: "cursorProxy",
    })),
  });

  return new Response(req.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
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

function reasoningField(providerKey) {
  return providerKey === "minimax" ? "reasoning_details" : "reasoning_content";
}

function hasReasoningValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function readReasoning(providerKey, obj) {
  if (!obj) return null;
  const field = reasoningField(providerKey);
  if (!Object.prototype.hasOwnProperty.call(obj, field)) return null;
  const value = obj[field];
  return hasReasoningValue(value) ? value : null;
}

function reasoningSize(value) {
  if (!hasReasoningValue(value)) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function serializeReasoning(providerKey, value) {
  return providerKey === "minimax" ? JSON.stringify(value) : String(value);
}

function deserializeReasoning(providerKey, stored) {
  if (!hasReasoningValue(stored)) return null;
  if (providerKey !== "minimax") return stored;
  try {
    const parsed = JSON.parse(stored);
    return hasReasoningValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadStoredReasoning(providerKey, key) {
  return deserializeReasoning(providerKey, await kvGet(key));
}

function parseRetryDelaysMs() {
  const raw = process.env.KV_RETRY_DELAYS_MS;
  if (!raw) return [40, 120, 240, 400];
  const parsed = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : [40, 120, 240, 400];
}

async function waitForStoredReasoning(providerKey, key) {
  const retryDelaysMs = parseRetryDelaysMs();
  let stored = await loadStoredReasoning(providerKey, key);
  if (stored != null) {
    return { stored, waitedMs: 0, attempts: 0 };
  }

  let waitedMs = 0;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    const delay = retryDelaysMs[attempt];
    await sleep(delay);
    waitedMs += delay;
    stored = await loadStoredReasoning(providerKey, key);
    if (stored != null) {
      return { stored, waitedMs, attempts: attempt + 1 };
    }
  }

  return { stored: null, waitedMs, attempts: retryDelaysMs.length };
}

function hasReasoningField(providerKey, obj) {
  return obj && Object.prototype.hasOwnProperty.call(obj, reasoningField(providerKey));
}

function updateStreamReasoning(providerKey, current, value) {
  if (!hasReasoningValue(value)) return current;
  if (providerKey === "minimax") return value;
  return (current || "") + value;
}

function stripReasoning(obj) {
  if (!obj) return obj;
  const { reasoning_content, reasoning_details, ...rest } = obj;
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

  // Flatten all image_url parts to process them with bounded concurrency
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

  if (replacements.length > 1) {
    let totalBytes = 0;
    for (const r of replacements) totalBytes += r.imageUrl.length;
    log("VISION_BATCH", "images:", replacements.length, "totalUriBytes:", totalBytes);
  }

  // Bounded concurrency: vision endpoints (e.g. MiniMax-VL-01) rate-limit on
  // bursts. Cache hits short-circuit before the network call so this only
  // throttles real upstream requests. Override via VISION_CONCURRENCY env.
  const concurrency = (() => {
    const raw = parseInt(process.env.VISION_CONCURRENCY || "", 10);
    if (Number.isFinite(raw) && raw >= 1) return raw;
    return 2;
  })();

  const processOne = async ({ msgIdx, partIdx, imageUrl }) => {
    try {
      const cacheKey = await sha256ImageHash(imageUrl);
      const cached = await kvGet(cacheKey);
      if (cached) {
        return { msgIdx, partIdx, description: cached, fromCache: true };
      }

      const description = await describeImage(imageUrl);
      if (description) {
        await kvSet(cacheKey, description).catch(() => {});
      }
      return { msgIdx, partIdx, description, fromCache: false };
    } catch (err) {
      // Always-on: vision failures must be visible in production so operators
      // notice when a key/quota/oversized payload is breaking multi-image runs.
      diag("VISION_ERROR", err?.message);
      return { msgIdx, partIdx, description: null, error: err?.message };
    }
  };

  const results = new Array(replacements.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, replacements.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= replacements.length) return;
        results[idx] = await processOne(replacements[idx]);
      }
    });
  await Promise.all(workers);

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
        text: "(image attachment unavailable" + (error ? ": " + error : "") + ")",
      };
      errors++;
    }
  }

  // Merge consecutive text parts and (when no image_url remains) collapse to a
  // single string. DeepSeek / MiniMax non-vision chat endpoints are not
  // reliable about reading the 2nd+ entry of a multi-part text content array,
  // so leaving N separate {type:"text"} parts for N images causes only the
  // first description to be read by the model. Only touch user/system turns
  // we already rewrote — never assistant history.
  for (let i = 0; i < updated.length; i++) {
    const m = updated[i];
    if (m.role !== "user" && m.role !== "system") continue;
    if (!Array.isArray(m.content)) continue;

    const hasImages = m.content.some((p) => p?.type === "image_url");

    if (!hasImages) {
      const joined = m.content
        .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : ""))
        .filter((s) => typeof s === "string" && s.length > 0)
        .join("\n\n");
      m.content = joined.length > 0 ? joined : "(image attachment unavailable)";
      continue;
    }

    // image_url parts still present (vision-capable provider edge case): at
    // least merge runs of consecutive text parts into one.
    const merged = [];
    for (const p of m.content) {
      const isText = typeof p === "string" || p?.type === "text";
      const last = merged[merged.length - 1];
      if (isText && last && (typeof last === "string" || last.type === "text")) {
        const lastText = typeof last === "string" ? last : last.text;
        const curText = typeof p === "string" ? p : p.text;
        merged[merged.length - 1] = {
          type: "text",
          text: (lastText || "") + "\n\n" + (curText || ""),
        };
      } else {
        merged.push(p);
      }
    }
    m.content = merged;
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
  diag("REQ", req.method, pathname, "provider:", providerKey || "infer");

  if (isModelDiscoveryRequest(req, pathname, pathParam)) {
    return modelDiscoveryResponse(req);
  }

  // Parse body early for model-based routing (unified /v1 without provider query)
  let bodyText = "";
  let parsedBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyText = await req.text();
    try {
      parsedBody = JSON.parse(bodyText);
    } catch (err) {
      diag("BODY_PARSE_ERROR", "bodyLength:", bodyText.length, "err:", err?.message);
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
    diag("UNKNOWN_PROVIDER", "model:", parsedBody?.model, "provider:", providerKey);
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

  // Clean up Vercel rewrite query pollution
  searchParams.delete("path");
  searchParams.delete("provider");

  const queryString = searchParams.toString()
    ? "?" + searchParams.toString()
    : "";
  const upstreamUrl = provider.url + "/v1/" + pathParam + queryString;
  log("UPSTREAM", upstreamUrl, "provider:", providerKey);

  if (providerKey === "minimax" && parsedBody) {
    parsedBody.reasoning_split = true;
    bodyText = JSON.stringify(parsedBody);
  }

  const originalMessages = parsedBody?.messages ? [...parsedBody.messages] : null;

  const scopeUser = await cacheScopeUserId(req);
  const scope = providerKey + ":" + scopeUser;
  const replyReasoningKey = originalMessages
    ? await conversationHash(originalMessages, originalMessages.length, scope)
    : null;

  // Inject stored reasoning into ALL prior assistant messages by position.
  //
  // DeepSeek thinking mode REQUIRES reasoning_content on every prior assistant
  // turn (including tool-calling ones) — otherwise it returns:
  //   "The `reasoning_content` in the thinking mode must be passed back to the API."
  // When KV has nothing for a given turn (e.g. trivial greeting that produced no
  // thinking, or a turn not proxied through us, or KV race), we still inject a
  // placeholder so the field is present and the provider accepts the request.
  let injectedCount = 0;
  if (originalMessages) {
    const messages = parsedBody.messages;
    const assistantIndices = messages
      .map((m, i) => i)
      .filter((i) =>
        messages[i].role === "assistant" &&
        !hasReasoningField(providerKey, messages[i])
      );

    const fetched = await Promise.all(
      assistantIndices.map(async (i) => {
        const key = await conversationHash(originalMessages, i, scope);
        const result = await waitForStoredReasoning(providerKey, key);
        log(
          "INJECT idx:",
          i,
          "key:",
          key,
          "hit:",
          result.stored != null,
          "waitedMs:",
          result.waitedMs
        );
        return { i, key, ...result };
      })
    );

    let missedCount = 0;
    let recoveredCount = 0;
    for (const { i, stored, key, waitedMs, attempts } of fetched) {
      if (stored != null) {
        messages[i] = { ...messages[i], [reasoningField(providerKey)]: stored };
        injectedCount++;
        if (waitedMs > 0) {
          recoveredCount++;
          log("INJECT_RECOVERED", "idx:", i, "key:", key, "waitedMs:", waitedMs, "attempts:", attempts);
        }
      } else {
        // Inject a non-empty placeholder so the reasoning field is present.
        // DeepSeek/Kimi thinking mode require reasoning_content on every prior
        // assistant turn (including tool-call turns) and treat empty strings as
        // "missing", returning:
        //   "thinking is enabled but reasoning_content is missing in assistant ..."
        // The text below is intentionally generic: it is hidden from the client
        // (we strip reasoning_content before responding) and only used to satisfy
        // the provider's validator when the original reasoning was not captured
        // (e.g. the turn was produced before this proxy was in front, was a
        // simple greeting that produced no thinking, or the cache write was lost).
        const placeholder = providerKey === "minimax"
          ? [{ type: "text", text: "(prior reasoning unavailable)" }]
          : "(prior reasoning unavailable)";
        messages[i] = { ...messages[i], [reasoningField(providerKey)]: placeholder };
        missedCount++;
        log("INJECT_PLACEHOLDER", "idx:", i, "key:", key,
             "msgPreview:", messages[i].content?.slice?.(0, 60) || "(no content)");
      }
    }
    if (recoveredCount > 0) log("INJECT_RECOVERED", "count:", recoveredCount, "of:", fetched.length);
    if (missedCount > 0) log("INJECT_MISS", "missed:", missedCount, "of:", fetched.length);
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

    // Apply rewrites whenever ANY image_url part was processed (success OR
    // failure). The previous gate (`convertedCount > 0`) silently dropped the
    // failure-placeholder rewrites and forwarded the original image_url
    // blocks upstream, where DeepSeek/MiniMax accept the request but ignore
    // the images — producing nonsense answers.
    if (convertedCount + errors > 0) {
      parsedBody.messages = convertedMessages;
      bodyText = JSON.stringify(parsedBody);
      diag(
        "CONVERTED_IMAGES",
        "ok:", convertedCount,
        "err:", errors,
        "provider:", providerKey
      );

      // Safety net: when every image failed and the request is non-streaming,
      // surface a 4xx so the client sees the failure on turn 1 instead of
      // getting a degraded reply that taints subsequent turns. Streaming
      // requests fall through (placeholders forwarded) since we cannot easily
      // change status mid-response.
      if (convertedCount === 0 && errors > 0 && parsedBody.stream !== true) {
        return jsonErrorResponse(
          502,
          `Vision provider failed for all ${errors} image attachment(s); request not forwarded. Start a fresh conversation after fixing the vision backend.`,
          "vision_unavailable",
          "upstream_error"
        );
      }
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
  // Connect-phase timeout (cleared as soon as headers arrive — never aborts the
  // streaming body). Safe to apply on Docker too; default 15s, override via
  // UPSTREAM_CONNECT_TIMEOUT_MS (set to 0 to disable).
  const connectTimeoutMs = (() => {
    const raw = parseInt(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || "", 10);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 15000;
  })();
  const connectController = connectTimeoutMs > 0 ? new AbortController() : null;
  const connectTimer = connectController
    ? setTimeout(() => connectController.abort(), connectTimeoutMs)
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
            ? `Upstream provider timed out (>${connectTimeoutMs}ms connecting)`
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
    diag("UPSTREAM_ERROR_STATUS", upstreamRes.status, "provider:", providerKey, "body:", errText);
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

    const reasoning = readReasoning(providerKey, json.choices?.[0]?.message);
    if (hasReasoningValue(reasoning) && replyReasoningKey) {
      log("CACHE non-stream key:", replyReasoningKey);
      await kvSet(replyReasoningKey, serializeReasoning(providerKey, reasoning));
    }
    log("NONSTREAM_DONE", "choices:", json.choices?.length, "reasoning_chars:", reasoningSize(reasoning));
    diag("RES", upstreamRes.status, "provider:", providerKey, "ms:", Date.now() - t0);
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

  // Guard against an upstream that advertises text/event-stream but returns no
  // body (misbehaving providers, 204-on-stream). Without this, getReader() throws.
  if (!upstreamRes.body) {
    log("STREAM_EMPTY_BODY", upstreamRes.status);
    return new Response(null, {
      status: upstreamRes.status,
      headers: { "content-type": contentType || "text/event-stream" },
    });
  }

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
    let accReasoning = null;
    let accContent = "";
    let doneSeen = false;
    let lastCachedReasoningSize = 0;

    async function cacheReasoningSnapshot(force = false) {
      if (!replyReasoningKey || !hasReasoningValue(accReasoning)) return;
      const size = reasoningSize(accReasoning);
      if (!force) {
        const minDelta = providerKey === "minimax" ? 1 : 256;
        if (size === 0 || size < lastCachedReasoningSize + minDelta) return;
      }
      lastCachedReasoningSize = size;
      log("CACHE stream key:", replyReasoningKey, "size:", size, "force:", force);
      // Mid-stream snapshots are fire-and-forget so KV latency does not stall
      // the SSE forward path. Forced writes (at [DONE] / finally) still await
      // to guarantee durability before the request ends.
      const writePromise = kvSet(replyReasoningKey, serializeReasoning(providerKey, accReasoning))
        .catch((err) => log("CACHE_WRITE_ERROR", err?.message));
      if (force) await writePromise;
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const rawLines = buffer.split("\n");
        buffer = rawLines.pop();
        // Strip trailing \r so CRLF line endings don't leak into our re-emitted
        // SSE frames (which use \n\n terminators).
        const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

        for (const line of lines) {
          if (!line.startsWith("data: ")) {
            if (line.trim()) await writer.write(encoder.encode(line + "\n"));
            continue;
          }

          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            doneSeen = true;
            const reasoningChars = reasoningSize(accReasoning);
            log("STREAM_DONE", "reasoning:", reasoningChars, "content:", accContent.length);
            if (reasoningChars > 5000 && accContent.length < 100) {
              log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
            }
            await cacheReasoningSnapshot(true);
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            const chunkReasoning = readReasoning(providerKey, delta);
            accReasoning = updateStreamReasoning(providerKey, accReasoning, chunkReasoning);
            if (hasReasoningValue(chunkReasoning)) {
              await cacheReasoningSnapshot();
            }
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
    } catch (err) {
      // Expected on the timeout path: reader.cancel() makes the in-flight
      // reader.read() reject (typically "Stream was cancelled" / AbortError).
      // Without this catch the rejection escapes the unawaited IIFE and Vercel
      // surfaces it as an unhandled error in the function logs even though we
      // already emitted a graceful stream_timeout SSE frame to the client.
      // For genuine upstream stream failures (network drop mid-stream), log
      // once at diag level so they remain visible without being noisy.
      if (timedOut) {
        log("STREAM_READ_ABORTED_AFTER_TIMEOUT", err?.name, err?.message);
      } else {
        diag("STREAM_READ_ERROR", err?.name, err?.message);
        try {
          const errMsg = JSON.stringify({
            error: {
              message: `Upstream stream interrupted: ${err?.message || err?.name || "unknown error"}`,
              type: "upstream_error",
              code: "stream_read_error",
            },
          });
          await writer.write(encoder.encode("data: " + errMsg + "\n\n"));
        } catch {}
      }
    } finally {
      if (streamTimer) clearTimeout(streamTimer);

      if (timedOut) {
        const reasoningChars = reasoningSize(accReasoning);
        diag("STREAM_TIMEOUT", "reasoning:", reasoningChars, "content:", accContent.length,
            "timeout:", effectiveTimeoutSec + "s");
        if (reasoningChars > 5000 && accContent.length < 100) {
          log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
        }
        try {
          const timeoutMsg = JSON.stringify({
            error: {
              message: `Stream timed out after ${effectiveTimeoutSec}s. The model was still generating (reasoning: ${reasoningChars} chars, content: ${accContent.length} chars). Retry with a smaller prompt, or increase STREAM_TIMEOUT_SECONDS.`,
              type: "stream_timeout",
              code: "stream_timeout",
            },
          });
          await writer.write(encoder.encode("data: " + timeoutMsg + "\n\n"));
        } catch {}
      }

      if (!doneSeen && !timedOut && originalMessages && hasReasoningValue(accReasoning)) {
        const reasoningChars = reasoningSize(accReasoning);
        log("STREAM_FINALLY", "reasoning:", reasoningChars, "content:", accContent.length);
        if (reasoningChars > 5000 && accContent.length < 100) {
          log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
        }
        await cacheReasoningSnapshot(true);
      }
      diag("RES", upstreamRes.status, "provider:", providerKey, "ms:", Date.now() - t0);
      await writer.close();
    }
  })().catch((err) => {
    // Last-resort guard: ensure no rejection escapes the unawaited IIFE.
    // Anything reaching here means the inner try/catch/finally itself threw
    // (e.g. writer.close() race after cancel). Logging only — the response
    // stream has already been returned to the client.
    diag("STREAM_PIPE_ERROR", err?.name, err?.message);
  });

  return new Response(readable, {
    status: upstreamRes.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
