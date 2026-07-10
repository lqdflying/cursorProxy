import { kvDelete, kvGet } from "./kv.js";
import { jsonErrorResponse } from "./auth.js";
import { cacheScopeUserId, conversationHash } from "./cache.js";
import {
  deriveCompatPromptCacheKey,
  deriveOpenAICompatSessionAnchor,
  hasOpenAICompatPreviousResponseUnsupportedScope,
  markOpenAICompatPreviousResponseUnsupportedScope,
  openAICompatPreviousResponseFailureKind,
  shouldAutoInjectPromptCacheKeyForCompat,
} from "./openaicompat-cache.js";
import { normalizeOpenAICompatResponsesInputContent } from "./azure-openai.js";
import { createLogger } from "./logger.js";

// Emits under the proxy tag: PREV_RESP_ID_*, MESSAGES_TO_INPUT, INPUT_CHAIN,
// STORE_OPT_OUT, etc. are part of the request-orchestration log stream.
const { log, diag } = createLogger("proxy");

// KV cache versions for stored response IDs. Bump to invalidate all cached
// chains for a provider after a scope-shape change.
const AZURE_OPENAI_RESPONSE_CACHE_VERSION = "v7";
const OPENAICOMPAT_RESPONSE_CACHE_VERSION = "v1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function expandResponsesInputToolCallStart(items, start) {
  if (!Array.isArray(items) || start <= 0 || start >= items.length) return start;
  const needed = new Set();
  for (let i = start; i < items.length; i++) {
    if (items[i]?.type !== "function_call_output") continue;
    const callId = String(items[i].call_id || "").trim();
    if (callId) needed.add(callId);
  }
  if (needed.size === 0) return start;
  let expandedStart = start;
  for (let i = start - 1; i >= 0 && needed.size > 0; i--) {
    if (items[i]?.type !== "function_call") continue;
    const callId = String(items[i].call_id || "").trim();
    if (!needed.has(callId)) continue;
    needed.delete(callId);
    expandedStart = i;
  }
  return expandedStart;
}

function countResponsesFunctionCallOutputs(items) {
  if (!Array.isArray(items)) return 0;
  let count = 0;
  for (const item of items) {
    if (item?.type === "function_call_output") count++;
  }
  return count;
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

/**
 * previous_response_id chaining via KV, for azureopenai (always) and
 * openaicompat in Responses wire mode. The caller gates on
 * `providerKey === "azureopenai" || openaiCompatResponses` before calling.
 *
 * Supports two input formats from the client:
 *   1. Legacy Chat Completions `messages` — renamed to `input` with
 *      tool-call normalization (role:"tool" → function_call_output,
 *      assistant.tool_calls → function_call items).
 *   2. Native Responses API `input` — items already in Responses format.
 *
 * When a prior assistant turn exists, try to recover the response ID from KV
 * and use previous_response_id chaining so the upstream reuses server-side
 * context instead of re-reasoning from scratch on every turn. Falls back to
 * stateless full-input-array mode on KV miss.
 *
 * Mutates parsedBody in place (store, input, previous_response_id,
 * prompt_cache_key; deletes messages).
 *
 * @returns {Promise<{
 *   errorResponse: Response|null,   // 400 store_background_conflict — caller returns it as-is
 *   changed: boolean,               // true → caller re-serializes parsedBody into bodyText
 *   replyKey: string|null,          // KV key (sans prefix) for storing this turn's response ID
 *   previousKvKey: string|null,     // full KV key of the prior turn (for stale-ID cleanup)
 *   cachePrefix: string,            // KV namespace prefix ("azresp:" | "oairesp:")
 *   chainScope: string|null,        // provider-specific cache scope
 *   statelessRetryInput: Array|null // full input array for the stateless retry fallback
 * }>}
 */
export async function prepareResponsesChain({
  req,
  parsedBody,
  providerKey,
  upstreamModelName,
  openaiCompatResponses,
  openAICompatSub2ApiCache,
  openAICompatResponsesHaloCache,
}) {
  // Provider-specific KV namespace prefix and cache version.
  // Azure uses azresp: (distinct from the openaicompat oairesp: namespace)
  // so the two providers' response IDs are isolated even when they share a
  // KV backend. The result names (replyKey, chainScope, etc.) are
  // provider-generic despite the legacy "azure" naming at the call site.
  const cachePrefix = openaiCompatResponses ? "oairesp:" : "azresp:";
  const cacheVersion = openaiCompatResponses
    ? OPENAICOMPAT_RESPONSE_CACHE_VERSION
    : AZURE_OPENAI_RESPONSE_CACHE_VERSION;

  const result = {
    errorResponse: null,
    changed: false,
    replyKey: null,
    previousKvKey: null,
    cachePrefix,
    chainScope: null,
    statelessRetryInput: null,
  };

  // Provider-wide guard: store:false (privacy/compliance opt-out) is
  // incompatible with background:true (background responses cannot
  // resume without server-side stored state). Reject before any shape
  // detection so the rule applies uniformly to messages, array input,
  // string input, and missing input. A later sanitizer would silently
  // flip store:true on a background job, defeating the opt-out — that
  // path is also hardened, but rejecting here is the source of truth.
  if (parsedBody?.store === false && parsedBody?.background === true) {
    diag("STORE_BACKGROUND_CONFLICT", "provider:", providerKey, "store:false + background:true is incompatible");
    result.errorResponse = jsonErrorResponse(
      400,
      `store:false is incompatible with background:true. Background responses require server-side stored state to resume. Send store:true to allow chaining, or drop background:true for a stateless one-shot.`,
      "store_background_conflict",
      "invalid_request_error"
    );
    return result;
  }

  const hasMessages = parsedBody?.messages && !parsedBody?.input;
  const hasInput = parsedBody?.input && Array.isArray(parsedBody.input);

  if (!(hasMessages || hasInput)) {
    return result;
  }

  const azureScopeUser = await cacheScopeUserId(req);
  let openAICompatSessionAnchor = "";
  if (openAICompatSub2ApiCache) {
    const modelForCache = parsedBody?.model || upstreamModelName || "";
    if (!parsedBody.prompt_cache_key && shouldAutoInjectPromptCacheKeyForCompat(modelForCache)) {
      const derivedPromptCacheKey = await deriveCompatPromptCacheKey(parsedBody, modelForCache);
      if (derivedPromptCacheKey) {
        parsedBody.prompt_cache_key = derivedPromptCacheKey;
        diag("OAI_PROMPT_CACHE_KEY_INJECTED",
          "model:", modelForCache,
          "key:", derivedPromptCacheKey.slice(0, 24) + "...");
      }
    }
    openAICompatSessionAnchor = await deriveOpenAICompatSessionAnchor(req, parsedBody, modelForCache);
    if (openAICompatSessionAnchor) {
      diag("OAI_SESSION_ANCHOR",
        "source:", openAICompatSessionAnchor.split("_").slice(0, -1).join("_") || "derived",
        "hash:", openAICompatSessionAnchor.slice(-32));
    }
  }
  // Cache scope: provider-specific identifiers so response IDs from one
  // provider/deployment/resource are never replayed against another.
  //
  // Azure scope embeds:
  //   1. The resolved Azure deployment name — retargeting an alias
  //      (e.g. AZURE_OPENAI_GENERAL_ALIAS_TARGET changing from
  //      gpt-5.5 to gpt-5.5-mini) yields a fresh cache bucket, so
  //      clients won't replay a previous_response_id from the old
  //      deployment and 400 on Azure. Mid-conversation deployment
  //      switches (gpt-general vs gpt-5.5) also stay isolated.
  //   2. A normalized Azure resource/endpoint identifier — moving the
  //      proxy to a different AZURE_OPENAI_ENDPOINT or rotating
  //      AZURE_FOUNDRY_RESOURCE invalidates response ids that only
  //      exist on the prior resource, even when the deployment name
  //      stays the same.
  //
  // OpenAI-compatible scope uses the normalized upstream BASE URL
  // (origin + path with trailing slashes and trailing /v1 stripped)
  // instead of hostname only, so path-based gateways
  // (https://gw/tenantA/v1 vs https://gw/tenantB/v1) don't collide.
  // The resolved model name (after alias resolution) is embedded so
  // switching models mid-conversation yields a fresh bucket.
  let chainScope;
  if (openaiCompatResponses) {
    const upstreamBase = (process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com")
      .replace(/\/+$/, "").replace(/\/v1$/i, "");
    chainScope = openAICompatSub2ApiCache
      ? [
        providerKey,
        cacheVersion,
        "sub2api",
        upstreamBase,
        parsedBody?.model || "(none)",
        openAICompatSessionAnchor || "(none)",
        azureScopeUser,
      ].join(":")
      : openAICompatResponsesHaloCache
        ? [
          providerKey,
          cacheVersion,
          "halo",
          upstreamBase,
          parsedBody?.model || "(none)",
          String(parsedBody?.prompt_cache_key || "").trim() || "(none)",
          azureScopeUser,
        ].join(":")
      : [
        providerKey,
        cacheVersion,
        upstreamBase,
        parsedBody?.model || "(none)",
        azureScopeUser,
      ].join(":");
  } else {
    const azureScopeDeployment = parsedBody?.model || "(none)";
    const azureScopeResource = (
      process.env.AZURE_OPENAI_ENDPOINT
      || process.env.AZURE_FOUNDRY_RESOURCE
      || "(none)"
    ).trim().toLowerCase().replace(/\/+$/, "");
    chainScope = [
      providerKey,
      cacheVersion,
      azureScopeResource,
      azureScopeDeployment,
      azureScopeUser,
    ].join(":");
  }
  result.chainScope = chainScope;
  const prevRespUnsupported = openaiCompatResponses
    && hasOpenAICompatPreviousResponseUnsupportedScope(chainScope);

  // Build a normalized array for hashing and finding the last assistant
  // turn.  For messages we use the Chat Completions array directly (role
  // field already present).  For native input items in Responses format,
  // the role is either explicit (item.role) or implied by the type
  // (function_call → assistant, function_call_output → tool).  The hash
  // array is used only for conversationHash(), which does
  // JSON.stringify(slice) — same items produce the same key across turns.
  let hashItems;
  let lastAssistantIdx = -1;
  let hashBoundaryIdx = -1;

  if (hasMessages) {
    hashItems = [...parsedBody.messages];
    lastAssistantIdx = hashItems.reduce(
      (last, m, i) => (m.role === "assistant" ? i : last),
      -1,
    );
    hashBoundaryIdx = lastAssistantIdx;
  } else {
    // hasInput — native Responses-format array.
    // Walk backward to find the contiguous assistant block.  Skip
    // trailing non-assistant items first (the next request ends with
    // a new user item), then scan through the assistant block to find
    // both its first and last items.  The block may span multiple
    // items (e.g. message{role:assistant} then function_call items).
    hashItems = [...parsedBody.input];
    let asstBlockEnd = -1;
    let asstBlockStart = hashItems.length;

    // Skip trailing non-assistant items so the scan starts at the
    // last assistant-related item (if any).
    let start = hashItems.length - 1;
    const isAsstItem = (item) =>
      item.role === "assistant" ||
      item.type === "function_call" ||
      item.type === "custom_tool_call" ||
      item.type === "apply_patch_call" ||
      item.type === "reasoning" ||
      item.type === "file_search_call" ||
      item.type === "web_search_call" ||
      item.type === "computer_call" ||
      item.type === "computer_use_preview_call" ||
      item.type === "code_interpreter_call" ||
      item.type === "image_generation_call" ||
      item.type === "local_shell_call" ||
      item.type === "shell_call" ||
      item.type === "mcp_call" ||
      item.type === "mcp_list_tools" ||
      item.type === "mcp_approval_request" ||
      (item.type === "message" && item.role === "assistant");
    while (start >= 0 && !isAsstItem(hashItems[start])) {
      start--;
    }
    if (start >= 0) {
      asstBlockEnd = start;
      asstBlockStart = start + 1;
      // Walk backward through the contiguous assistant block.
      for (let i = start; i >= 0; i--) {
        if (!isAsstItem(hashItems[i])) break;
        asstBlockStart = i;
      }
    }

    // hashBoundary: items BEFORE the assistant block (for response ID hash)
    // lastAssistantIdx: LAST item in the assistant block (for trim)
    hashBoundaryIdx = asstBlockStart;
    lastAssistantIdx = asstBlockEnd;
  }

  // Compute hashes from the original Cursor/request input shape before
  // forwarding-only normalizers mutate parsedBody. Do not move any
  // input/messages/tool/content normalization above this block unless the
  // read and write hash fixtures are updated together.
  // conversationHash(messages, upTo, scope) hashes messages.slice(0, upTo),
  // so upTo=hashItems.length hashes ALL items.
  result.replyKey = await conversationHash(hashItems, hashItems.length, chainScope);

  // Honour an explicit client opt-out before doing anything KV-related.
  // store:false means the client requires this turn to be stateless
  // upstream (compliance / privacy-sensitive workloads). That implies
  // BOTH directions:
  //   - we must not forward a previous_response_id (which would replay
  //     prior turns the client has just asked us to forget), and
  //   - we must not persist this turn's response id for the next turn.
  // Skip the KV read entirely and clear the write key. The store:false +
  // background:true conflict is rejected as a 400 at the provider-wide
  // guard above, so reaching here with storeOptOut implies background
  // is omitted or false.
  const storeOptOut = parsedBody.store === false;
  if (storeOptOut) {
    result.replyKey = null;
    diag("STORE_OPT_OUT", "provider:", providerKey, "client sent store:false — chaining disabled (no prev lookup, no KV write)");
  }
  if (prevRespUnsupported) {
    result.replyKey = null;
    diag("OAI_PREV_RESP_UNSUPPORTED_SKIP", "provider:", providerKey, "mode:", "stateless");
  }

  // Look up a cached response ID from the prior turn.
  // hashBoundaryIdx marks items BEFORE the contiguous assistant block.
  let prevRespId = null;
  if (!storeOptOut && !prevRespUnsupported && hashBoundaryIdx >= 0) {
    const prevRespKey = await conversationHash(hashItems, hashBoundaryIdx, chainScope);
    result.previousKvKey = cachePrefix + prevRespKey;
    const readResult = await waitForAzResponseId(result.previousKvKey);
    if (readResult) {
      prevRespId = readResult;
      diag("PREV_RESP_ID_FOUND", "key:", prevRespKey, "id:", prevRespId);
    } else {
      diag("PREV_RESP_ID_MISS", "key:", prevRespKey);
    }
  }

  // store=true is required for previous_response_id lookups to work, but
  // we only set it for clients that didn't explicitly opt out above. When
  // storeOptOut is true, parsedBody.store stays false and Azure won't
  // persist server-side state for this turn.
  if (!storeOptOut) {
    parsedBody.store = true;
  }

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

    const fullInput = parsedBody.messages.reduce((acc, item) => {
      acc.push(...normalizeAzureInput(item));
      return acc;
    }, []);

    if (prevRespId) {
      // If trimming would produce an empty input, force stateless mode.
      // Azure rejects previous_response_id with no new items.
      const nextMessages = parsedBody.messages.slice(lastAssistantIdx + 1);
      if (nextMessages.length === 0) {
        prevRespId = null;
        result.statelessRetryInput = null;
        log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
             "lastAssistantIdx:", lastAssistantIdx,
             "totalItems:", parsedBody.messages.length);
      } else {
        if (openaiCompatResponses) {
          result.statelessRetryInput = cloneJson(fullInput);
        }
        // Only send input items that appeared AFTER the last assistant.
        // Azure replays the full prior conversation server-side.
        const trimmedInput = nextMessages.reduce((acc, item) => {
          acc.push(...normalizeAzureInput(item));
          return acc;
        }, []);
        const toolOutputCount = countResponsesFunctionCallOutputs(trimmedInput);
        if (openAICompatResponsesHaloCache && toolOutputCount > 0) {
          prevRespId = null;
          parsedBody.input = fullInput;
          diag("OAI_RESP_HALO_TOOL_OUTPUT_STATELESS",
               "provider:", providerKey,
               "inputItems:", fullInput.length,
               "toolOutputs:", toolOutputCount);
        } else {
          parsedBody.input = trimmedInput;
          parsedBody.previous_response_id = prevRespId;
        }
      }
    }
    if (!prevRespId && !parsedBody.input) {
      // Stateless fallback — full input array (but response is still stored
      // so the NEXT turn can chain from it).
      parsedBody.input = fullInput;
    }
    delete parsedBody.messages;
    result.changed = true;
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
      const trimStart = openAICompatSub2ApiCache
        ? expandResponsesInputToolCallStart(parsedBody.input, lastAssistantIdx + 1)
        : lastAssistantIdx + 1;
      const trimmedInput = parsedBody.input.slice(trimStart);
      const toolOutputCount = countResponsesFunctionCallOutputs(trimmedInput);
      if (trimmedInput.length === 0) {
        prevRespId = null;
        result.statelessRetryInput = null;
        log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
             "lastAssistantIdx:", lastAssistantIdx,
             "totalItems:", parsedBody.input.length);
      } else {
        if (openaiCompatResponses) {
          result.statelessRetryInput = cloneJson(parsedBody.input);
        }
        if (openAICompatResponsesHaloCache && toolOutputCount > 0) {
          prevRespId = null;
          diag("OAI_RESP_HALO_TOOL_OUTPUT_STATELESS",
               "provider:", providerKey,
               "inputItems:", parsedBody.input.length,
               "toolOutputs:", toolOutputCount);
        } else {
          parsedBody.input = trimmedInput;
          parsedBody.previous_response_id = prevRespId;
        }
      }
    }
    result.changed = true;
    diag("INPUT_CHAIN", "provider:", providerKey,
         "inputItems:", parsedBody.input.length,
         "trimmed:", prevRespId ? "yes" : "no (stateless)",
         "prevResp:", prevRespId ? prevRespId.slice(0, 20) + "..." : "(none)");
  }

  return result;
}

/**
 * Some OpenAI-compatible Responses gateways reject or lose
 * previous_response_id state. Retry once in stateless mode with the full
 * input array so Cursor gets an answer. Unsupported upstreams are suppressed
 * for a TTL; stale IDs are deleted so the retry can refresh the oairesp key.
 *
 * @returns {Promise<
 *   {handled: false} |
 *   {errorResponse: Response} |
 *   {handled: true, upstreamRes: Response, parsedBody: Object,
 *    bodyText: string, contentType: string, isStream: boolean,
 *    clearReplyKey: boolean}
 * >}
 */
export async function retryPreviousResponseFailure({
  upstreamRes,
  parsedBody,
  providerKey,
  openaiCompatResponses,
  openAICompatSub2ApiCache,
  statelessRetryInput,
  chainScope,
  previousKvKey,
  fetchUpstream,
  connectTimeoutMs,
}) {
  if (!(
    openaiCompatResponses
    && parsedBody?.previous_response_id
    && statelessRetryInput
    && (upstreamRes.status === 400 || upstreamRes.status === 404)
  )) {
    return { handled: false };
  }
  const errText = await upstreamRes.clone().text().catch(() => "");
  const previousResponseFailureKind = openAICompatPreviousResponseFailureKind(upstreamRes.status, errText);
  if (
    !previousResponseFailureKind ||
    (previousResponseFailureKind === "tool_output_missing" && openAICompatSub2ApiCache)
  ) {
    return { handled: false };
  }
  let clearReplyKey = false;
  if (previousResponseFailureKind === "unsupported") {
    markOpenAICompatPreviousResponseUnsupportedScope(chainScope);
    clearReplyKey = true;
  } else if (previousResponseFailureKind === "not_found" && previousKvKey) {
    await kvDelete(previousKvKey);
  }
  const retryBody = cloneJson(parsedBody);
  retryBody.input = cloneJson(statelessRetryInput);
  delete retryBody.previous_response_id;
  const retryNormalized = normalizeOpenAICompatResponsesInputContent(providerKey, retryBody).parsedBody;
  const retryBodyText = JSON.stringify(retryNormalized);
  const retryTag = previousResponseFailureKind === "unsupported"
    ? "OAI_PREV_RESP_UNSUPPORTED_RETRY"
    : previousResponseFailureKind === "tool_output_missing"
      ? "OAI_TOOL_OUTPUT_RETRY"
      : "OAI_PREV_RESP_NOT_FOUND_RETRY";
  diag(retryTag,
    "status:", upstreamRes.status,
    "inputItems:", retryNormalized.input?.length || 0);
  try {
    const retryRes = await fetchUpstream(retryBodyText);
    const contentType = retryRes.headers.get("content-type") || "";
    const isStream = contentType.includes("text/event-stream");
    log("UPSTREAM_STATUS_PREV_RETRY", retryRes.status, "provider:", providerKey, "stream:", isStream);
    return {
      handled: true,
      upstreamRes: retryRes,
      parsedBody: retryNormalized,
      bodyText: retryBodyText,
      contentType,
      isStream,
      clearReplyKey,
    };
  } catch (err) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    log("UPSTREAM_PREV_RETRY_ERROR", err?.name, err?.message);
    return {
      errorResponse: new Response(
        JSON.stringify({
          error: {
            message: isTimeout
              ? `Upstream provider timed out (>${connectTimeoutMs}ms connecting) during previous_response_id stateless retry`
              : `Upstream previous_response_id stateless retry failed: ${err?.message}`,
            type: "upstream_error",
            code: isTimeout ? "upstream_timeout" : "upstream_fetch_error",
          },
        }),
        {
          status: 504,
          headers: { "content-type": "application/json" },
        }
      ),
    };
  }
}
