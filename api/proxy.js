export const config = { runtime: "edge" };

import { kvGet, kvSet } from "./kv.js";
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
import { cacheScopeUserId, conversationHash, normalizedConversationHash, sha256ImageHash } from "./cache.js";
import {
  isModelDiscoveryRequest,
  modelDiscoveryResponse,
  normalizeParsedBodyModel,
  providerFromModel,
  withPublicResponseModel,
} from "./models.js";
import {
  extractClaudeThinkingBlocks,
  hasReasoningValue,
  injectClaudeThinkingBlocks,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAzResponseId(key, retries = 2) {
  // Response IDs are written to KV before the proxy responds to Cursor,
  // so the next request usually finds the key immediately. Short retry
  // window covers the rare race where Cursor fires the next turn while
  // the current turn's finally block is still flushing.
  const delays = retries > 0 ? [0, 80, 200] : [0];
  for (let i = 0; i < Math.min(delays.length, retries + 1); i++) {
    if (i > 0) await sleep(delays[i]);
    const stored = await kvGet(key);
    if (stored) return stored;
  }
  return null;
}

export default async function handler(req) {
  const t0 = Date.now();
  let azureReplyKey = null; // KV key for saving Azure response ID
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
  {
    const remapResult = remapAnthropicInput(providerKey, parsedBody);
    parsedBody = remapResult.parsedBody;
    if (remapResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  // Azure OpenAI Responses API uses "input" natively. Do not normalize native
  // Responses input items (input_text, output_text, function_call_output, etc.).
  // Azure OpenAI previous_response_id chaining via KV.
  //
  // Supports two input formats from the client:
  //   1. Legacy Chat Completions `messages` — renamed to `input` with
  //      tool-call normalization (role:"tool" → function_call_output,
  //      assistant.tool_calls → function_call items).
  //   2. Native Responses API `input` — items already in Responses format.
  //
  // When a prior assistant turn exists, try to recover the response ID from KV
  // and use previous_response_id chaining so Azure reuses server-side context
  // instead of re-reasoning from scratch on every turn. Falls back to stateless
  // full-input-array mode on KV miss.
  if (providerKey === "azureopenai") {
    const hasMessages = parsedBody?.messages && !parsedBody?.input;
    const hasInput = parsedBody?.input && Array.isArray(parsedBody.input);

    if (hasMessages || hasInput) {
      const azureScopeUser = await cacheScopeUserId(req);
      const azureScope = providerKey + ":" + azureScopeUser;

      // Build a normalized array for hashing and finding the last assistant
      // turn.  For messages we use the Chat Completions array directly (role
      // field already present).  For native input items in Responses format,
      // the role is either explicit (item.role) or implied by the type
      // (function_call → assistant, function_call_output → tool).  The hash
      // array is used only for conversationHash(), which does
      // JSON.stringify(slice) — same items produce the same key across turns.
      let hashItems;
      let lastAssistantIdx = -1;

      if (hasMessages) {
        hashItems = [...parsedBody.messages];
        lastAssistantIdx = hashItems.reduce(
          (last, m, i) => (m.role === "assistant" ? i : last),
          -1,
        );
      } else {
        // hasInput — native Responses-format array.
        // Walk backward to find the start of the contiguous assistant turn
        // at the tail.  The turn may be multiple items in Responses format
        // (e.g. message{role:assistant} then function_call items).  Using
        // only the very last assistant-related item for the trim boundary
        // would leak the preceding message item into the forwarded input.
        hashItems = parsedBody.input;
        lastAssistantIdx = -1;
        let asstBlockStart = hashItems.length;
        for (let i = hashItems.length - 1; i >= 0; i--) {
          const item = hashItems[i];
          const isAsst = item.role === "assistant" ||
            item.type === "function_call" ||
            (item.type === "message" && item.role === "assistant");
          if (!isAsst) break;
          asstBlockStart = i;
        }
        lastAssistantIdx = asstBlockStart < hashItems.length ? asstBlockStart - 1 : -1;
      }

      // Compute the reply key now so we can save the response ID after the
      // upstream call (messages are deleted below in the messages path).
      // conversationHash(messages, upTo, scope) hashes messages.slice(0, upTo),
      // so upTo=hashItems.length hashes ALL items.
      azureReplyKey = await conversationHash(hashItems, hashItems.length, azureScope);

      // Look up a cached response ID from the prior turn.
      // upTo=lastAssistantIdx gives items BEFORE the assistant. That slice
      // equals the full-message write key from the prior turn (where upTo was
      // messages.length and the last message was the assistant).
      let prevRespId = null;
      if (lastAssistantIdx >= 0) {
        const prevRespKey = await conversationHash(hashItems, lastAssistantIdx, azureScope);
        const readResult = await waitForAzResponseId("azresp:" + prevRespKey);
        if (readResult) {
          prevRespId = readResult;
          diag("PREV_RESP_ID_FOUND", "key:", prevRespKey, "id:", prevRespId);
        } else {
          diag("PREV_RESP_ID_MISS", "key:", prevRespKey);
        }
      }

      // store=true is required for previous_response_id lookups to work.
      // Even on first/KV-miss turns we must persist the response so the ID
      // we save to KV is actually retrievable on the next turn.  The sanitizer
      // below only injects store=false when the field is absent, so setting it
      // here unconditionally overrides that default.
      parsedBody.store = true;

      if (hasMessages) {
        // Chat Completions → Responses conversion with tool-call normalization.
        // Chat Completions clients use role:"tool" for tool results and
        // assistant.tool_calls for function calls.  The Responses API expects
        // function_call_output and function_call items respectively.
        const normalizeAzureInput = (item) => {
          // Tool result
          if (item.role === "tool") {
            return [{
              type: "function_call_output",
              call_id: item.tool_call_id || "",
              output: typeof item.content === "string"
                ? item.content
                : JSON.stringify(item.content || ""),
            }];
          }
          // Assistant with tool_calls: emit text content (if any), then each
          // tool call as a function_call item that the Responses API can thread.
          if (item.role === "assistant" && item.tool_calls?.length) {
            const items = [];
            if (item.content) {
              items.push({ type: "message", role: "assistant", content: item.content });
            }
            for (const tc of item.tool_calls) {
              items.push({
                type: "function_call",
                call_id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "{}",
              });
            }
            return items;
          }
          return [item];
        };

        if (prevRespId) {
          // If trimming would produce an empty input, force stateless mode.
          // Azure rejects previous_response_id with no new items.
          if (parsedBody.messages.slice(lastAssistantIdx + 1).length === 0) {
            prevRespId = null;
            log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
                 "lastAssistantIdx:", lastAssistantIdx,
                 "totalItems:", parsedBody.messages.length);
          } else {
            // Only send input items that appeared AFTER the last assistant.
            // Azure replays the full prior conversation server-side.
            parsedBody.input = parsedBody.messages.slice(lastAssistantIdx + 1)
              .reduce((acc, item) => {
                acc.push(...normalizeAzureInput(item));
                return acc;
              }, []);
            parsedBody.previous_response_id = prevRespId;
          }
        } else {
          // Stateless fallback — full input array (but response is still stored
          // so the NEXT turn can chain from it).
          parsedBody.input = parsedBody.messages.reduce((acc, item) => {
            acc.push(...normalizeAzureInput(item));
            return acc;
          }, []);
        }
        delete parsedBody.messages;
        bodyText = JSON.stringify(parsedBody);
        diag("MESSAGES_TO_INPUT", "provider:", providerKey,
             "inputItems:", parsedBody.input.length,
             "prevResp:", prevRespId ? prevRespId.slice(0, 20) + "..." : "(none)");
      } else {
        // Native input — items already in Responses API format, no conversion
        // needed.  On KV hit: trim to items after last assistant and chain.
        // On KV miss: leave the full input as-is for stateless mode.

        // Lightweight detection probe: scan for Chat-Completions-shaped tool
        // entries that the current path does NOT normalize.  If these appear
        // in production, a full normalization pass (shared helper) is warranted.
        // Category counts tell us which specific shapes need handling.
        let nRoleTool = 0;
        let nAssistantToolCalls = 0;
        for (const item of parsedBody.input) {
          if (item.role === "tool") { nRoleTool++; continue; }
          if (item.role === "assistant" && item.tool_calls?.length) { nAssistantToolCalls++; }
        }
        if (nRoleTool > 0 || nAssistantToolCalls > 0) {
          diag("INPUT_HAS_LEGACY_TOOLS", "provider:", providerKey,
               "totalItems:", parsedBody.input.length,
               "roleTool:", nRoleTool,
               "assistantToolCalls:", nAssistantToolCalls);
        }

        if (prevRespId) {
          // If trimming would produce an empty input, force stateless mode.
          // Azure rejects previous_response_id with no new items.
          if (parsedBody.input.slice(lastAssistantIdx + 1).length === 0) {
            prevRespId = null;
            log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
                 "lastAssistantIdx:", lastAssistantIdx,
                 "totalItems:", parsedBody.input.length);
          } else {
            parsedBody.input = parsedBody.input.slice(lastAssistantIdx + 1);
            parsedBody.previous_response_id = prevRespId;
          }
        }
        bodyText = JSON.stringify(parsedBody);
        diag("INPUT_CHAIN", "provider:", providerKey,
             "inputItems:", parsedBody.input.length,
             "trimmed:", prevRespId ? "yes" : "no (stateless)",
             "prevResp:", prevRespId ? prevRespId.slice(0, 20) + "..." : "(none)");
      }
    }
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

  // Normalize the model name after any injection/stripping, then capture
  // the bare deployment name that Azure Foundry expects in URL paths.
  modelNames = normalizeParsedBodyModel(parsedBody);
  upstreamModelName = modelNames.bare;
  responseModelName = modelNames.publicId;
  if (modelNames.changed) {
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_STRIP", "from:", modelNames.input, "to:", upstreamModelName);
  }
  // Set azureModelName unconditionally after model normalization.
  // Previously this was a lazy-init that could read a stale value.
  if (providerKey === "azureopenai" || providerKey === "azureanthropic") {
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

  // --- Claude thinking block injection (azureanthropic only) ---
  // Inject cached thinking blocks into prior assistant messages so Claude
  // doesn't re-reason from scratch on every turn when thinking.type === "adaptive".
  // The existing reasoning bridge (DeepSeek/Kimi/MiniMax) uses reasoning_content
  // as a sibling field — Claude uses multi-block content arrays, hence separate logic.
  if (providerKey === "azureanthropic" && parsedBody?.messages && parsedBody?.thinking?.type && parsedBody?.thinking?.type !== "disabled") {
    const claudeInjected = await injectClaudeThinkingBlocks(parsedBody, originalMessages, scope, conversationHash, normalizedConversationHash);
    if (claudeInjected > 0) {
      bodyText = JSON.stringify(parsedBody);
      diag("CLAUDE_THINKING_INJECTED", "count:", claudeInjected);
    }
  }

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
      "bodyLen:", (bodyText || "").length,
      "model:", parsedBody?.model,
      "stream:", parsedBody?.stream,
      "msgCount:", parsedBody?.messages?.length,
      "thinkingType:", parsedBody?.thinking?.type,
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

    // Convert Anthropic non-streaming response to OpenAI format.
    // Extract and cache thinking blocks BEFORE mapping, since the mapper
    // discards them (only text/tool_use blocks survive the conversion).
    if (providerKey === "azureanthropic") {
      if (parsedBody?.thinking?.type === "adaptive" && originalMessages) {
        const claudeThinkKey = "claude_thinking:" + await normalizedConversationHash(
          originalMessages, originalMessages.length, scope
        );
        const thinkingBlocks = extractClaudeThinkingBlocks(json);
        if (thinkingBlocks) {
          diag("CLAUDE_THINKING_WRITE_SOURCE",
               "key:", claudeThinkKey,
               "msgCount:", originalMessages?.length,
               "roles:", originalMessages?.map((m, i) => `${i}:${m.role || "?"}`).join(","));
          await kvSet(claudeThinkKey, JSON.stringify(thinkingBlocks))
            .catch((err) => diag("CLAUDE_THINKING_WRITE_ERROR", err?.message));
          const totalChars = thinkingBlocks.reduce((sum, b) => sum + (typeof b.thinking === "string" ? b.thinking.length : 0), 0);
          diag("CLAUDE_THINKING_CACHED", "key:", claudeThinkKey, "blocks:", thinkingBlocks.length, "chars:", totalChars);
        }
      }
      json = mapAnthropicResponseToOpenAI(json);
    }

    // Convert Responses API output to Chat Completions format
    if (providerKey === "azureopenai") {
      const azureRespId = json.id;
      json = mapResponsesToOpenAI(json);
      // Save the Azure response ID to KV so the next turn can chain via
      // previous_response_id instead of re-sending the full conversation.
      if (azureRespId && azureReplyKey) {
        log("CACHE_AZ_RESP_ID", "key:", azureReplyKey, "id:", azureRespId);
        await kvSet("azresp:" + azureReplyKey, azureRespId);
      }
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
    let azureResponseId = null; // captured from response.created for KV write
    // Track Anthropic tool_use blocks by index for converting input_json_delta
    // to OpenAI-style tool_calls format.
    const anthropicToolState = new Map(); // index -> { id, name, partialJson }

    // Track Azure Responses API function_call items for converting
    // response.function_call_arguments.delta to OpenAI tool_calls.
    const responsesToolState = new Map(); // call_id -> { id, name, partialJson }

    // Track Claude thinking blocks for KV caching (azureanthropic + adaptive thinking).
    // Store the content_block object from content_block_start directly, then mutate
    // its fields as thinking_delta / signature_delta arrive.  This preserves the
    // exact shape including empty-string fields (e.g. thinking: "" for omitted
    // thinking) so the cached block round-trips unchanged.
    const claudeThinkBlocks = new Map(); // index -> content_block object
    const claudeThinkActive = providerKey === "azureanthropic" &&
      parsedBody?.thinking?.type && parsedBody?.thinking?.type !== "disabled";
    let claudeThinkingCached = false;
    let azureRespCached = false;

    // Pre-compute the Claude thinking cache key using normalized hash so
    // the write-side key matches the read-side key regardless of content
    // format changes that Cursor may apply between turns.
    let claudeThinkKey = null;
    if (claudeThinkActive && originalMessages) {
      claudeThinkKey = "claude_thinking:" + await normalizedConversationHash(
        originalMessages, originalMessages.length, scope
      );
    }

    // Aggregate Anthropic SSE event counts per stream to reduce DEBUG log volume.
    // Per-event logging was ~800 log lines per stream; this collapses to 1.
    const anthropicEventCounts = { total: 0 };

    async function cacheClaudeThinking() {
      if (claudeThinkingCached || !claudeThinkKey || claudeThinkBlocks.size === 0) return;
      // Serialize blocks in index order.  The objects are the original
      // content_block_start payloads with mutated fields, so the shape matches
      // the final non-streaming content array exactly.
      const sorted = [...claudeThinkBlocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]) => block);
      // Guard against broken streams: if any thinking block lacks a signature,
      // the block is incomplete (stream died after thinking_delta but before
      // signature_delta).  Caching and re-injecting an unverified block would
      // break the next turn.  redacted_thinking blocks don't carry signatures.
      const incomplete = sorted.some((b) => b.type === "thinking" && !b.signature);
      if (incomplete) {
        diag("CLAUDE_THINKING_INCOMPLETE", "key:", claudeThinkKey,
             "blocks:", sorted.length, "hint: stream ended before signature_delta");
        return;
      }
      await kvSet(claudeThinkKey, JSON.stringify(sorted))
        .catch((err) => diag("CLAUDE_THINKING_WRITE_ERROR", err?.message));
      claudeThinkingCached = true;
      const totalChars = sorted.reduce((sum, b) => sum + (typeof b.thinking === "string" ? b.thinking.length : 0), 0);
      diag("CLAUDE_THINKING_WRITE_SOURCE",
           "key:", claudeThinkKey,
           "msgCount:", originalMessages?.length,
           "roles:", originalMessages?.map((m, i) => `${i}:${m.role || "?"}`).join(","));
      diag("CLAUDE_THINKING_CACHED", "key:", claudeThinkKey, "blocks:", sorted.length, "chars:", totalChars);
    }

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

    async function cacheAzResponseId() {
      if (!azureResponseId || !azureReplyKey || azureRespCached) return;
      azureRespCached = true;
      log("CACHE_AZ_RESP_ID", "key:", azureReplyKey, "id:", azureResponseId);
      await kvSet("azresp:" + azureReplyKey, azureResponseId)
        .catch((err) => log("CACHE_AZ_WRITE_ERROR", err?.message));
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
            // Avoid double [DONE] emission when response.completed was already
            // handled above (Azure Responses API may emit both).
            if (doneSeen) continue;
            doneSeen = true;
            const reasoningChars = reasoningSize(accReasoning);
            log("STREAM_DONE", "reasoning:", reasoningChars, "content:", accContent.length);
            if (reasoningChars > 5000 && accContent.length < 100) {
              log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
            }
            await cacheReasoningSnapshot(true);
            await cacheAzResponseId();
            await cacheClaudeThinking();
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            let json = JSON.parse(data);

            // Transform Anthropic SSE events into OpenAI-compatible format.
            // Anthropic uses events like content_block_delta with delta.text_delta,
            // but the proxy and Cursor expect choices[0].delta.content.
            if (providerKey === "azureanthropic") {
              // Count ALL events per stream BEFORE any suppression branches,
              // so thinking_delta / signature_delta / content_block_start for
              // thinking / redacted_thinking are included in the aggregated log.
              anthropicEventCounts.total++;
              let evType = json.type || "unknown";
              // For compound event types, append the subtype so
              // thinking_delta/signature_delta/text_delta are distinguishable
              // and content_block_start subtypes (thinking, text, tool_use,
              // redacted_thinking) are tracked separately.
              if (json.type === "content_block_delta" && json.delta?.type) {
                evType = "content_block_delta:" + json.delta.type;
              } else if (json.type === "content_block_start" && json.content_block?.type) {
                evType = "content_block_start:" + json.content_block.type;
              }
              anthropicEventCounts[evType] = (anthropicEventCounts[evType] || 0) + 1;

              // When adaptive thinking is active, suppress thinking_delta and
              // signature_delta events: update the cached content_block object
              // in place instead of forwarding to Cursor.  The content_block
              // from content_block_start is stored directly so its exact shape
              // (including empty-string fields like thinking: "" for omitted
              // thinking) round-trips unchanged.
              if (claudeThinkActive && json?.delta?.type === "thinking_delta") {
                const idx = json.index ?? 0;
                const block = claudeThinkBlocks.get(idx);
                if (block) block.thinking = (block.thinking || "") + (json.delta.thinking || "");
                continue;
              }
              if (claudeThinkActive && json?.delta?.type === "signature_delta") {
                const idx = json.index ?? 0;
                const block = claudeThinkBlocks.get(idx);
                if (block) block.signature = (block.signature || "") + (json.delta.signature || "");
                continue;
              }
              if (claudeThinkActive && json?.type === "content_block_start") {
                const ct = json?.content_block?.type;
                if (ct === "thinking" || ct === "redacted_thinking") {
                  // Store the block object directly — deltas will mutate its
                  // fields in place above.  For omitted thinking the block
                  // already carries thinking: "" which is preserved as-is.
                  claudeThinkBlocks.set(json.index ?? 0, { ...json.content_block });
                  continue;
                }
              }
              const mapped = mapAnthropicSSEToOpenAI(json, anthropicToolState);
              if (mapped === "[DONE]") {
                doneSeen = true;
                log("STREAM_DONE_VIA_MESSAGE_STOP", "content:", accContent.length);
                await cacheReasoningSnapshot(true);
                await cacheClaudeThinking();
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
                // Capture the response ID from the first SSE event so we can
                // write it to KV and enable previous_response_id chaining on
                // the next turn.
                if (currentResponsesEvent === "response.created" && !azureResponseId) {
                  azureResponseId = json?.response?.id || null;
                  if (azureResponseId) {
                    log("STREAM_AZ_RESP_ID", "id:", azureResponseId);
                  }
                }
                // Emit downstream [DONE] when the Responses API signals completion.
                // Cursor expects OpenAI Chat Completions stream semantics, which
                // always terminate with data: [DONE].  Without this, a stream that
                // ends via response.completed (no raw [DONE] line) looks hung.
                if (currentResponsesEvent === "response.completed") {
                  doneSeen = true;
                  log("STREAM_DONE_VIA_RESPONSE_COMPLETED", "content:", accContent.length);
                  await cacheReasoningSnapshot(true);
                  await cacheAzResponseId();
                  await writer.write(encoder.encode("data: [DONE]\n\n"));
                }
                continue; // skip events that produce no output
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

      // Azure response ID may have been captured from response.created but
      // not yet cached — either because the stream ended via response.completed
      // (no data: [DONE]), or because originalMessages is null for Azure so
      // the reasoning guard above short-circuits.  Write it here when available
      // and the stream finished normally (not timed out).
      if (!timedOut) {
        await cacheAzResponseId();
        await cacheClaudeThinking();
      }
      if (providerKey === "azureanthropic" && anthropicEventCounts.total > 0) {
        log("ANTHROPIC_EVENTS", anthropicEventCounts);
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
