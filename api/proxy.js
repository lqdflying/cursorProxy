export const config = { runtime: "edge" };

import { kvSet } from "./kv.js";
import {
  mapAnthropicResponseToOpenAI,
  mapAnthropicSSEToOpenAI,
  normalizeAnthropicContentTypes,
  remapAnthropicInput,
  sanitizeAzureAnthropicBody,
} from "./azure-anthropic.js";
import {
  mapResponsesSSEToOpenAI,
  mapResponsesToOpenAI,
  normalizeAzureOpenAITools,
  sanitizeAzureOpenAIBody,
} from "./azure-openai.js";
import { checkProxyAuth, jsonErrorResponse } from "./auth.js";
import { cacheScopeUserId, conversationHash, sha256ImageHash } from "./cache.js";
import {
  isModelDiscoveryRequest,
  modelDiscoveryResponse,
  normalizeParsedBodyModel,
  providerFromModel,
  withPublicResponseModel,
} from "./models.js";
import {
  hasReasoningValue,
  injectStoredReasoning,
  readReasoning,
  reasoningSize,
  serializeReasoning,
  stripResponseChunk,
  updateStreamReasoning,
} from "./reasoning.js";
import { convertImagesToText } from "./vision-bridge.js";

const DEBUG = process.env.DEBUG === "true";

const PROVIDERS = {
  deepseek: {
    url: process.env.UPSTREAM_DEEPSEEK || "https://api.deepseek.com",
    host: "api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  kimi: {
    url: process.env.UPSTREAM_KIMI || "https://api.moonshot.ai",
    host: "api.moonshot.ai",
    apiKeyEnv: "KIMI_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  minimax: {
    url: process.env.UPSTREAM_MINIMAX || "https://api.minimax.io",
    host: "api.minimax.io",
    apiKeyEnv: "MINIMAX_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  azureopenai: {
    apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    authHeaderName: "api-key",
    authHeaderPrefix: "",
    buildUrl(model, pathParam, queryString) {
      // Responses API: model is in request body, not URL path.
      // Path remapped from chat/completions → responses.
      const base = process.env.AZURE_OPENAI_ENDPOINT
        || `https://${process.env.AZURE_FOUNDRY_RESOURCE}.cognitiveservices.azure.com`;
      const version = process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
      const remapped = pathParam === "chat/completions" ? "responses" : pathParam;
      const qs = queryString ? `&${queryString.slice(1)}` : "";
      return `${base}/openai/${remapped}?api-version=${version}${qs}`;
    },
  },
  azureanthropic: {
    apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    authHeaderName: "x-api-key",
    authHeaderPrefix: "",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    buildUrl(model, pathParam, queryString) {
      const base = process.env.AZURE_ANTHROPIC_ENDPOINT
        || `https://${process.env.AZURE_FOUNDRY_RESOURCE}.services.ai.azure.com`;
      // queryString already includes leading "?" — use as-is
      const qs = queryString || "";
      // Remap OpenAI-compatible paths to Anthropic Messages API equivalents.
      // Cursor sends chat/completions — Anthropic expects messages.
      const remapped = pathParam === "chat/completions" ? "messages" : pathParam;
      return `${base}/anthropic/v1/${remapped}${qs}`;
    },
  },
};

function log(...args) {
  if (DEBUG) console.log("[cursorProxy:proxy]", ...args);
}

function diag(...args) {
  console.log("[cursorProxy:proxy]", ...args);
}

function upstreamApiKey(providerKey) {
  const meta = PROVIDERS[providerKey] ?? PROVIDERS.deepseek;
  return process.env[meta.apiKeyEnv] || "";
}

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
    const response = modelDiscoveryResponse(req);
    diag("RES", response.status, "path:", pathParam, "provider: models", "ms:", Date.now() - t0);
    return response;
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

  const clientModelName = parsedBody?.model;
  if (!providerKey) {
    providerKey = providerFromModel(clientModelName);
  }
  if (!providerKey) {
    providerKey = "deepseek";
  }

  let modelNames = normalizeParsedBodyModel(parsedBody);
  let upstreamModelName = modelNames.bare;
  let responseModelName = modelNames.publicId;
  if (modelNames.changed) {
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_STRIP", "from:", modelNames.input, "to:", upstreamModelName);
  }

  log("RESOLVED", "model:", responseModelName || parsedBody?.model || "(none)", "provider:", providerKey, "stream:", parsedBody?.stream);

  // Azure Foundry expects the bare deployment name (e.g. "claude-sonnet-4-6"),
  // not client-facing proxy model IDs such as "cursorproxy/claude-sonnet-4-6".
  let azureModelName = upstreamModelName;
  {
    const remapResult = remapAnthropicInput(providerKey, parsedBody);
    parsedBody = remapResult.parsedBody;
    if (remapResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  // Azure OpenAI Responses API uses "input" natively. Do not normalize native
  // Responses input items (input_text, output_text, function_call_output, etc.).
  // Only support legacy Chat Completions clients by renaming messages → input.
  if (providerKey === "azureopenai" && parsedBody?.messages && !parsedBody?.input) {
    parsedBody.input = parsedBody.messages;
    delete parsedBody.messages;
    bodyText = JSON.stringify(parsedBody);
    diag("MESSAGES_TO_INPUT", "provider:", providerKey, "from:", "messages", "to:", "input");
  }

  {
    const contentTypeResult = normalizeAnthropicContentTypes(providerKey, parsedBody);
    parsedBody = contentTypeResult.parsedBody;
    if (contentTypeResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const toolsResult = normalizeAzureOpenAITools(providerKey, parsedBody);
    parsedBody = toolsResult.parsedBody;
    if (toolsResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const openAiSanitized = sanitizeAzureOpenAIBody(providerKey, parsedBody, azureModelName);
    parsedBody = openAiSanitized.parsedBody;
    if (openAiSanitized.sanitized) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const anthropicSanitized = sanitizeAzureAnthropicBody(providerKey, parsedBody);
    parsedBody = anthropicSanitized.parsedBody;
    if (anthropicSanitized.sanitized) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerKey)) {
    diag("UNKNOWN_PROVIDER", "model:", parsedBody?.model, "provider:", providerKey);
    return jsonErrorResponse(
      400,
      `Unknown provider "${providerKey}". Use deepseek, kimi, minimax, azureopenai, or azureanthropic (or set model to a matching name, e.g. cursorproxy/claude-sonnet-4-6 or claude-sonnet-4-6).`,
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

  // Inject a default model when missing from the request body
  if (parsedBody && !parsedBody.model && providerKey !== "azureopenai") {
    const defaults = { deepseek: "deepseek-chat", kimi: "kimi-latest", minimax: "MiniMax-M2.7", azureanthropic: "claude-sonnet-4-6" };
    parsedBody.model = defaults[providerKey] || "deepseek-chat";
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_INJECTED", "model:", parsedBody.model);
  }

  modelNames = normalizeParsedBodyModel(parsedBody);
  upstreamModelName = modelNames.bare;
  responseModelName = modelNames.publicId;
  if (modelNames.changed) {
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_STRIP", "from:", modelNames.input, "to:", upstreamModelName);
  }

  // Keep azureModelName in sync with parsedBody.model — it may have been set or
  // normalized above (e.g. azureanthropic with no model in the request).
  // Must happen before buildUrl so the URL path contains the correct deployment name.
  if ((providerKey === "azureopenai" || providerKey === "azureanthropic") && !azureModelName) {
    azureModelName = upstreamModelName;
  }

  // Clean up Vercel rewrite query pollution
  searchParams.delete("path");
  searchParams.delete("provider");

  const queryString = searchParams.toString()
    ? "?" + searchParams.toString()
    : "";
  const upstreamUrl = provider.buildUrl
    ? provider.buildUrl(azureModelName, pathParam, queryString)
    : provider.url + "/v1/" + pathParam + queryString;
  log("UPSTREAM", upstreamUrl, "provider:", providerKey);

  if (providerKey === "minimax" && parsedBody) {
    parsedBody.reasoning_split = true;
    bodyText = JSON.stringify(parsedBody);
  }

  // Always inject DeepSeek thinking mode params (proxy controls this; default: high)
  if (providerKey === "deepseek" && parsedBody) {
    parsedBody.thinking = { type: "enabled" };
    const effortEnv = (process.env.DEEPSEEK_REASONING_EFFORT || "").trim().replace(/^["']|["']$/g, "");
    const effort = effortEnv === "max" ? "max" : "high";
    parsedBody.reasoning_effort = effort;
    bodyText = JSON.stringify(parsedBody);
    diag("THINKING", "provider: deepseek", "reasoning_effort:", effort, "raw_env:", process.env.DEEPSEEK_REASONING_EFFORT || "(unset)");
  }

  const originalMessages = parsedBody?.messages ? [...parsedBody.messages] : null;

  const scopeUser = await cacheScopeUserId(req);
  const scope = providerKey + ":" + scopeUser;
  const replyReasoningKey = originalMessages
    ? await conversationHash(originalMessages, originalMessages.length, scope)
    : null;

  let injectedCount = 0;
  if (originalMessages) {
    const injected = await injectStoredReasoning({
      providerKey,
      parsedBody,
      originalMessages,
      scope,
      conversationHash,
    });
    parsedBody = injected.parsedBody;
    injectedCount = injected.injectedCount;
    bodyText = JSON.stringify(parsedBody);
  }
  log("INJECTED", injectedCount, "/", originalMessages?.filter((m) => m.role === "assistant").length || 0);

  // Convert images to text for providers that don't support vision inputs
  // DeepSeek and MiniMax chat endpoints do not accept inline image_url content.
  // The vision API (MiniMax VL-01 by default) is called to describe images,
  // and the descriptions are injected as text before forwarding.
  const providersWithoutVision = ["deepseek", "minimax"];
  if (providersWithoutVision.includes(providerKey) && parsedBody?.messages) {
    const visionT0 = Date.now();
    const {
      messages: convertedMessages,
      convertedCount,
      errors,
    } = await convertImagesToText(parsedBody.messages, sha256ImageHash);
    const visionMs = Date.now() - visionT0;

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
        "provider:", providerKey,
        "visionMs:", visionMs
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

    // Pre-stream budget guard for Vercel Edge: the platform requires an
    // initial Response within ~25s. If vision + reasoning injection have
    // already eaten most of the budget, fail fast with a clear error rather
    // than getting silently killed by the platform mid-fetch. Disabled when
    // not running on Vercel (Docker has no such limit).
    if (process.env.VERCEL) {
      const elapsedMs = Date.now() - t0;
      const budgetMs = parseInt(process.env.PRESTREAM_BUDGET_MS || "", 10) || 22000;
      if (elapsedMs > budgetMs) {
        diag("PRESTREAM_BUDGET_EXCEEDED", "elapsedMs:", elapsedMs, "budgetMs:", budgetMs);
        return jsonErrorResponse(
          504,
          `Pre-stream work exceeded the ${budgetMs}ms budget on Vercel Edge (took ${elapsedMs}ms). Most likely cause: a slow vision API call. Lower VISION_TIMEOUT_MS, raise VISION_CONCURRENCY, or send fewer images per turn.`,
          "prestream_timeout",
          "upstream_error"
        );
      }
    }
  }

  // Azure endpoints reject requests carrying unknown headers or dual auth,
  // so start from an empty set instead of mutating while iterating Headers.
  const isAzureProvider = providerKey === "azureopenai" || providerKey === "azureanthropic";
  const headers = isAzureProvider ? new Headers() : new Headers(req.headers);

  // Build dynamic host header: use provider.host when available,
  // otherwise extract hostname from the constructed upstream URL.
  if (provider.host) {
    headers.set("host", provider.host);
  } else {
    try {
      headers.set("host", new URL(upstreamUrl).hostname);
    } catch { /* fall through */ }
  }

  // Clean up headers that shouldn't leak upstream
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("content-length");
  headers.delete("content-type");
  headers.delete("transfer-encoding");
  headers.delete("accept-encoding");
  headers.set("content-type", "application/json");
  headers.set("accept-encoding", "identity");

  // Build dynamic auth header AFTER cleanup so it's not accidentally deleted.
  const authValue = provider.authHeaderPrefix + providerSecret;
  headers.set(provider.authHeaderName, authValue);

  // Apply provider-specific extra headers (e.g. anthropic-version for Azure)
  if (provider.extraHeaders) {
    for (const [k, v] of Object.entries(provider.extraHeaders)) {
      headers.set(k, v);
    }
  }

  // Dump the exact request being sent to Azure for debugging.
  // Gate behind DEBUG to avoid logging user prompts in production.
  if (DEBUG && (providerKey === "azureopenai" || providerKey === "azureanthropic")) {
    const hdrObj = {};
    headers.forEach((v, k) => (hdrObj[k] = v));
    // Redact auth keys from logs
    if (hdrObj["api-key"]) hdrObj["api-key"] = "***";
    if (hdrObj["x-api-key"]) hdrObj["x-api-key"] = "***";
    if (hdrObj["authorization"]) hdrObj["authorization"] = "***";
    diag(
      "UPSTREAM_REQUEST_DUMP",
      "url:", upstreamUrl,
      "method:", req.method,
      "headers:", JSON.stringify(hdrObj),
      "body:", (bodyText || "").slice(0, 500),
      "msgRoles:", parsedBody?.messages?.map((m, i) => `${i}:${m.role || "(none)"} type:${m.type || "-"}`)
    );
  }

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

    // Convert Anthropic non-streaming response to OpenAI format
    if (providerKey === "azureanthropic") {
      json = mapAnthropicResponseToOpenAI(json);
    }

    // Convert Responses API output to Chat Completions format
    if (providerKey === "azureopenai") {
      json = mapResponsesToOpenAI(json);
    }

    json = withPublicResponseModel(json, responseModelName);

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
    // Track Anthropic tool_use blocks by index for converting input_json_delta
    // to OpenAI-style tool_calls format.
    const anthropicToolState = new Map(); // index -> { id, name, partialJson }

    // Track Azure Responses API function_call items for converting
    // response.function_call_arguments.delta to OpenAI tool_calls.
    const responsesToolState = new Map(); // call_id -> { id, name, partialJson }

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
      let currentResponsesEvent = ""; // track event: line for Azure OpenAI Responses SSE
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
          // For Azure Anthropic, skip event: lines entirely — we convert data lines
          // into OpenAI-compatible format and emit only the transformed chunks.
          //
          // For Azure OpenAI (Responses API), track event: lines to use when
          // processing data: lines — the event name tells us what type of delta it is.
          if (providerKey === "azureopenai" && line.startsWith("event: ")) {
            currentResponsesEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            if (!(providerKey === "azureanthropic" || providerKey === "azureopenai")) {
              if (line.trim()) await writer.write(encoder.encode(line + "\n"));
            }
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
            let json = JSON.parse(data);

            // Transform Anthropic SSE events into OpenAI-compatible format.
            // Anthropic uses events like content_block_delta with delta.text_delta,
            // but the proxy and Cursor expect choices[0].delta.content.
            if (providerKey === "azureanthropic") {
              const mapped = mapAnthropicSSEToOpenAI(json, anthropicToolState);
              // Diagnostic: log event type and extracted text to debug silent streams
              log("ANTHROPIC_EVENT", "type:", json.type,
                   "index:", json.index,
                   "delta_type:", json.delta?.type,
                   "text:", json.delta?.text?.slice(0, 40),
                   "thinking:", json.delta?.thinking?.slice(0, 40),
                   "content_block_type:", json.content_block?.type);
              if (mapped === "[DONE]") {
                doneSeen = true;
                log("STREAM_DONE_VIA_MESSAGE_STOP", "content:", accContent.length);
                await cacheReasoningSnapshot(true);
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                continue;
              }
              if (!mapped) continue; // skip events that produce no output
              json = mapped;
            }

            // Transform Azure Responses API SSE events into OpenAI-compatible format.
            // Responses API uses named events (event: response.output_text.delta)
            // with data payloads, unlike Anthropic's data-only content_block_delta.
            if (providerKey === "azureopenai" && currentResponsesEvent) {
              const mapped = mapResponsesSSEToOpenAI(currentResponsesEvent, json, responsesToolState);
              if (mapped) {
                json = mapped;
              } else {
                continue; // skip events that produce no output (e.g. response.created)
              }
            }

            const delta = json.choices?.[0]?.delta;
            const chunkReasoning = readReasoning(providerKey, delta);
            accReasoning = updateStreamReasoning(providerKey, accReasoning, chunkReasoning);
            if (hasReasoningValue(chunkReasoning)) {
              await cacheReasoningSnapshot();
            }
            if (delta?.content != null) accContent += delta.content;
            json = withPublicResponseModel(json, responseModelName);
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
