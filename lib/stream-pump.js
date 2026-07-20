import { kvSet } from "./kv.js";
import { normalizedConversationHash } from "./cache.js";
import { mapAnthropicSSEToOpenAI } from "./azure-anthropic.js";
import {
  finalizeResponsesToolState,
  mapResponsesSSEToOpenAI,
  mapResponsesUsageToOpenAI,
} from "./azure-openai.js";
import { withPublicResponseModel } from "./models.js";
import {
  normalizeOpenAICompatChatCacheUsage,
  openAICompatChatCachedTokens,
} from "./openaicompat-cache.js";
import {
  hasReasoningValue,
  readReasoning,
  reasoningSize,
  serializeReasoning,
  stripResponseChunk,
  updateStreamReasoning,
} from "./reasoning.js";
import {
  isCursorGetMcpToolsName,
  isCursorShellToolName,
  isCursorSubagentToolName,
  isCursorTaskToolName,
  mapMissingResponsesToolArgsForProxy,
  mapResponsesToolArgsChunkForProxy,
  mapResponsesToolArgsContinuationForProxy,
  sanitizeCursorGetMcpToolsArgs,
  sanitizeCursorShellArgsForLocal,
  sanitizeCursorSubagentArgsForLocal,
  sanitizeCursorTaskArgs,
  validateCursorShellArgs,
} from "./cursor-tools.js";
import {
  incompleteResponsesToolStates,
  isResponsesToolArgDeltaEvent,
  isResponsesToolDoneEvent,
  responsesToolArgsForLog,
  responsesToolStateForLog,
  safeLogToken,
  summarizeJsonArgKeysForLog,
  summarizeToolArgShapeForLog,
  uniqueResponsesToolStates,
} from "./log-shapes.js";
import { createLogger } from "./logger.js";

// Emits under the proxy tag: STREAM_*, RES, CACHE_*, CLAUDE_THINKING_*, and
// the per-stream summaries are all part of the request-orchestration log
// stream that production dashboards filter on. Do not change the RES format.
const { log, diag } = createLogger("proxy");

// Soft caps for per-stream string accumulators. These prevent a runaway
// reasoning model from OOMing a single Vercel Edge instance during a long
// stream. The values are stored, not the forwarded SSE — clients still see
// the full upstream output; only the proxy's internal accumulators are bounded.
// Override via env when needed.
function readSizeCap(envName, fallback) {
  const raw = parseInt(process.env[envName] || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return fallback;
}
const ACC_CONTENT_CAP = readSizeCap("ACC_CONTENT_CAP_CHARS", 4_000_000);   // ~4MB chars
const ACC_REASONING_CAP = readSizeCap("ACC_REASONING_CAP_CHARS", 8_000_000); // ~8MB chars
const ACC_REFUSAL_CAP = 64_000;

/**
 * Streaming SSE pump: forwards the upstream event stream to the client as
 * OpenAI Chat Completions chunks, applying per-provider transforms (Anthropic
 * events, Azure/compat Responses events, Cursor tool-arg sanitization),
 * accumulating reasoning/content for KV caching, and enforcing the platform
 * stream timeout.
 *
 * Returns the client Response synchronously — the pump body runs as an
 * unawaited async task writing into a TransformStream, exactly like the
 * historical inline IIFE. Never await the pump.
 *
 * IMPORTANT: assemble the context at the call site AFTER all upstream retry
 * blocks have run — the stateless retry can null out azureReplyKey, and the
 * pump must see the final value so it doesn't cache a response ID for a
 * scope that was just marked stateless.
 */
export function startStreamPump({
  upstreamRes,
  contentType,
  t0,
  providerKey,
  openaiCompatResponses,
  openAICompatSub2ApiCache,
  openAICompatResponsesHaloCompatibleCache,
  openAICompatResponsesHaloCache,
  openAICompatChatCacheUsageFacade,
  responsesStreamIncludeUsage,
  upstreamModelName,
  responseModelName,
  azureAliasApplied,
  compatAliasApplied,
  parsedBody,
  originalMessages,
  scope,
  replyReasoningKey,
  azureReplyKey,
  respIdCachePrefix,
  requestSignal,
  upstreamFetchStartedAt,
  upstreamHeadersAt,
}) {
  const aliasApplied = azureAliasApplied || compatAliasApplied;
  const forcePublicModel = aliasApplied || providerKey === "glm" || providerKey === "fireworks";

  // Streaming timeout: defaults to 280s on Vercel (under the 300s limit),
  // 110s on EdgeOne Cloud Functions (under the 120s maxDuration), or 0 (disabled).
  // Also clamps to remaining platform budget so pre-stream work doesn't eat
  // into the wall-clock limit.
  const streamTimeoutRaw = process.env.STREAM_TIMEOUT_SECONDS;
  const streamTimeoutConfigured = streamTimeoutRaw != null && String(streamTimeoutRaw).trim() !== "";
  let streamTimeoutSec = parseInt(streamTimeoutRaw || "", 10);
  // A negative or non-numeric configured value silently falls back to the
  // default if we don't guard here, which masks operator misconfiguration.
  // Log loudly and treat it as unset so the platform default applies.
  if (streamTimeoutConfigured && (!Number.isFinite(streamTimeoutSec) || streamTimeoutSec < 0)) {
    diag("STREAM_TIMEOUT_INVALID", "raw:", streamTimeoutRaw, "fallback: platform default");
    streamTimeoutSec = NaN;
  }
  const elapsedSec = (Date.now() - t0) / 1000;
  const isVercel = Boolean(process.env.VERCEL);
  const isEdgeOneCloud = process.env.EDGEONE_CLOUD_FUNCTION === "true";
  const platformLimit = isVercel ? 295 : (isEdgeOneCloud ? 115 : Infinity);
  const maxStreamSec = platformLimit - elapsedSec - 5; // 5s safety margin
  const defaultStreamSec = isVercel ? 280 : (isEdgeOneCloud ? 110 : 0);
  const capToPlatform = (seconds) => Number.isFinite(maxStreamSec)
    ? Math.max(1, Math.min(seconds, maxStreamSec))
    : seconds;
  const effectiveTimeoutSec = streamTimeoutSec > 0
    ? capToPlatform(streamTimeoutSec)
    : (streamTimeoutConfigured && streamTimeoutSec === 0
      ? 0
      : (defaultStreamSec > 0 ? capToPlatform(defaultStreamSec) : 0));

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
  const downstreamReader = readable.getReader();

  const reader = upstreamRes.body.getReader();
  let timedOut = false;
  let streamTimer = null;
  let terminalOutcome = "open";
  let terminalAt = null;
  let requestCancelled = false;
  let cancelDownstreamResponse = null;
  const cancelFromRequest = () => {
    requestCancelled = true;
    if (terminalOutcome === "open") {
      terminalOutcome = "cancelled";
      terminalAt = Date.now();
    }
    reader.cancel(requestSignal?.reason).catch(() => {});
  };

  if (requestSignal?.aborted) {
    cancelFromRequest();
  } else {
    requestSignal?.addEventListener("abort", cancelFromRequest, { once: true });
  }

  if (effectiveTimeoutSec > 0) {
    streamTimer = setTimeout(() => {
      if (terminalOutcome !== "open") return;
      timedOut = true;
      terminalOutcome = "timeout";
      terminalAt = Date.now();
      reader.cancel().catch(() => {});
    }, effectiveTimeoutSec * 1000);
  }

  (async () => {
    let buffer = "";
    let accReasoning = null;
    let accContent = "";
    let accRefusal = "";
    let contentCapHit = false;
    let refusalCapHit = false;
    // Bounded append for plain-string accumulators. The forwarded SSE still
    // carries the full upstream text — only the proxy-side string used for
    // logging / size checks is truncated, so a 100MB reply doesn't pin 100MB
    // of heap on the function instance.
    function appendCapped(prev, addition, cap, label, flagSetter) {
      if (!addition) return prev;
      if (prev.length >= cap) {
        if (flagSetter) flagSetter();
        return prev;
      }
      if (prev.length + addition.length <= cap) return prev + addition;
      if (flagSetter) flagSetter();
      const room = cap - prev.length;
      log("STREAM_ACC_CAP_REACHED", "label:", label, "cap:", cap);
      return prev + addition.slice(0, room);
    }
    let doneSeen = false;
    let lastCachedReasoningSize = 0;
    let azureResponseId = null; // captured from response.created for KV write
    let azureResponseTerminalStatus = null;
    let azureResponseIncompleteReason = null;
    let azureFunctionDeltaCount = 0;
    let azureStreamSummaryLogged = false;
    // Track Anthropic tool_use blocks by index for converting input_json_delta
    // to OpenAI-style tool_calls format.
    const anthropicToolState = new Map(); // index -> { id, name, partialJson }

    // Track Azure Responses API function_call items for converting
    // response.function_call_arguments.delta to OpenAI tool_calls.
    const responsesToolState = new Map(); // call_id -> { id, name, partialJson }
    let responsesToolCallSeen = false;
    const bufferGpt56ToolChunks = openaiCompatResponses
      && upstreamModelName === "gpt-5.6-sol";
    let pendingGpt56ShellToolIndex = null;
    const deferredGpt56ToolChunks = [];
    let activePipelineStage = "read";

    async function writeEncoded(encodedValue) {
      const previousStage = activePipelineStage;
      activePipelineStage = "write";
      try {
        await writer.write(encodedValue);
      } catch (error) {
        const downstreamWriteError = new Error("Downstream stream write failed");
        downstreamWriteError.name = "DownstreamWriteError";
        downstreamWriteError.cause = error;
        throw downstreamWriteError;
      } finally {
        activePipelineStage = previousStage;
      }
    }

    async function flushDeferredGpt56ToolChunks(reason) {
      if (deferredGpt56ToolChunks.length === 0) {
        pendingGpt56ShellToolIndex = null;
        return;
      }

      const deferredChunks = deferredGpt56ToolChunks
        .splice(0)
        .sort((left, right) => {
          if (left.toolIndex !== right.toolIndex) {
            return left.toolIndex - right.toolIndex;
          }
          return left.order - right.order;
        });
      diag("OAI_GPT56_TOOL_CHUNKS_REORDERED",
           "shellIndex:", pendingGpt56ShellToolIndex ?? "(none)",
           "deferred:", deferredChunks.length,
           "reason:", reason);
      pendingGpt56ShellToolIndex = null;

      for (const deferredChunk of deferredChunks) {
        const publicDeferredChunk = withPublicResponseModel(
          deferredChunk.chunk,
          responseModelName,
          aliasApplied,
        );
        await writeEncoded(
          encoder.encode(
            "data: " + JSON.stringify(stripResponseChunk(publicDeferredChunk)) + "\n\n"
          )
        );
      }
    }

    function discardDeferredGpt56ToolChunks(reason) {
      if (deferredGpt56ToolChunks.length === 0) {
        pendingGpt56ShellToolIndex = null;
        return;
      }

      const discardedChunkCount = deferredGpt56ToolChunks.length;
      deferredGpt56ToolChunks.length = 0;
      pendingGpt56ShellToolIndex = null;
      diag("OAI_GPT56_TOOL_CHUNKS_DISCARDED",
           "discarded:", discardedChunkCount,
           "reason:", reason);
    }

    // Track Claude thinking blocks for KV caching (azureanthropic + adaptive thinking).
    // Store the content_block object from content_block_start directly, then mutate
    // its fields as thinking_delta / signature_delta arrive.  This preserves the
    // exact shape including empty-string fields (e.g. thinking: "" for omitted
    // thinking) so the cached block round-trips unchanged.
    const claudeThinkBlocks = new Map(); // index -> content_block object
    const claudeThinkActive = (providerKey === "azureanthropic" ||
      (providerKey === "anthropiccompat" && process.env.ANTHROPICCOMPAT_THINKING_CACHE === "true")) &&
      parsedBody?.thinking?.type && parsedBody?.thinking?.type !== "disabled";
    let claudeThinkingCached = false;
    let azureRespCached = false;
    let azureRespCacheDecisionLogged = false;
    let firstEventAt = null;
    let readCount = 0;
    let failureStage = "(none)";
    let lifecycleLogged = false;
    let streamWriteErrorLogged = false;

    function setTerminalOutcome(outcome) {
      if (terminalOutcome !== "open") return false;
      terminalOutcome = outcome;
      terminalAt = Date.now();
      return true;
    }

    function noteFailureStage(stage) {
      if (failureStage === "(none)") failureStage = stage;
    }

    function logStreamWriteError({ stage, error, cancelled }) {
      if (streamWriteErrorLogged) return;
      streamWriteErrorLogged = true;
      diag("STREAM_WRITE_ERROR",
           "stage:", stage,
           "cancelled:", cancelled,
           "type:", safeLogToken(error?.name || "Error"),
           "messageChars:", String(error?.message || "").length);
    }

    function isRateLimitStreamError(errorType, errorCode) {
      return /rate.?limit|too.?many.?requests|insufficient.?quota/i.test(
        `${errorType || ""} ${errorCode || ""}`,
      );
    }

    cancelDownstreamResponse = async (reason) => {
      noteFailureStage("write");
      const clientCancelled = requestSignal?.aborted === true;
      if (clientCancelled) {
        requestCancelled = true;
      }
      if (terminalOutcome === "open" || terminalOutcome === "completed") {
        terminalOutcome = clientCancelled ? "cancelled" : "write_error";
        terminalAt = Date.now();
      }
      azureResponseTerminalStatus = azureResponseTerminalStatus || "failed";
      discardDeferredGpt56ToolChunks(clientCancelled ? "cancelled" : "write_error");
      logStreamWriteError({
        stage: "readable_cancel",
        error: reason,
        cancelled: clientCancelled,
      });
      await Promise.all([
        reader.cancel(reason).catch(() => {}),
        writer.abort(reason).catch(() => {}),
      ]);
    };

    function logLifecycle() {
      if (!openaiCompatResponses || lifecycleLogged) return;
      lifecycleLogged = true;
      const finalizedAt = Date.now();
      const fetchStartedAt = upstreamFetchStartedAt || t0;
      diag("OAI_STREAM_LIFECYCLE",
           "wire:", "responses",
           "status:", upstreamRes.status,
           "headersMs:", upstreamHeadersAt == null ? "(none)" : Math.max(0, upstreamHeadersAt - fetchStartedAt),
           "firstEventMs:", firstEventAt == null ? "(none)" : Math.max(0, firstEventAt - fetchStartedAt),
           "terminal:", terminalOutcome,
           "terminalMs:", terminalAt == null ? "(none)" : Math.max(0, terminalAt - fetchStartedAt),
           "totalMs:", Math.max(0, finalizedAt - fetchStartedAt),
           "doneSeen:", doneSeen,
           "reads:", readCount,
           "timedOut:", timedOut,
           "cancelled:", requestCancelled,
           "stage:", failureStage);
    }

    async function writeDone() {
      if (doneSeen) return false;
      await writeEncoded(encoder.encode("data: [DONE]\n\n"));
      doneSeen = true;
      return true;
    }

    async function writeTerminalError({ message, type, code }) {
      if (doneSeen) return;
      await writeEncoded(encoder.encode("data: " + JSON.stringify({
        error: { message, type, code },
      }) + "\n\n"));
      await writeDone();
    }

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
    const azureEventCounts = { total: 0 };
    const openAICompatChatStreamDiag = providerKey === "openaicompat" && !openaiCompatResponses;
    let openAICompatChatStreamSummaryLogged = false;
    const openAICompatChatStreamStats = {
      chunks: 0,
      contentDeltas: 0,
      reasoningDeltas: 0,
      toolCallChunks: 0,
      toolCallStarts: 0,
      toolArgDeltas: 0,
      usageChunks: 0,
      parseErrors: 0,
      cachedTokens: null,
      finish: "(none)",
    };
    const openAICompatChatToolIds = new Set();
    let streamReadError = false;

    function countAzureEvent(eventName) {
      const key = eventName || "unknown";
      azureEventCounts.total++;
      azureEventCounts[key] = (azureEventCounts[key] || 0) + 1;
    }

    function logAzureStreamSummary(reason) {
      if (!(providerKey === "azureopenai" || openaiCompatResponses) || azureStreamSummaryLogged || azureEventCounts.total === 0) return;
      azureStreamSummaryLogged = true;
      diag(openaiCompatResponses ? "OAI_STREAM_SUMMARY" : "AZURE_STREAM_SUMMARY",
           "reason:", reason,
           "content:", accContent.length,
           "refusal:", accRefusal.length,
           "functionArgDeltas:", azureFunctionDeltaCount,
           "events:", JSON.stringify(azureEventCounts));
      if (accRefusal) {
        log("AZURE_REFUSAL_PREVIEW", accRefusal.slice(0, 240));
      }
    }

    function logOpenAICompatChatStreamSummary(reason) {
      if (!openAICompatChatStreamDiag || openAICompatChatStreamSummaryLogged) return;
      openAICompatChatStreamSummaryLogged = true;
      diag("OAI_CHAT_STREAM_SUMMARY",
           "provider:", providerKey,
           "reason:", reason,
           "chunks:", openAICompatChatStreamStats.chunks,
           "contentDeltas:", openAICompatChatStreamStats.contentDeltas,
           "content:", accContent.length,
           "reasoningDeltas:", openAICompatChatStreamStats.reasoningDeltas,
           "reasoning:", reasoningSize(accReasoning),
           "toolCalls:", openAICompatChatStreamStats.toolCallChunks,
           "toolStarts:", openAICompatChatStreamStats.toolCallStarts,
           "toolArgDeltas:", openAICompatChatStreamStats.toolArgDeltas,
           "finish:", openAICompatChatStreamStats.finish || "(none)",
           "usageChunks:", openAICompatChatStreamStats.usageChunks,
           "cached_tokens:", openAICompatChatStreamStats.cachedTokens ?? "(none)",
           "doneSeen:", doneSeen,
           "parseErrors:", openAICompatChatStreamStats.parseErrors);
    }

    function updateOpenAICompatChatStreamStats(json) {
      if (!openAICompatChatStreamDiag || !json || typeof json !== "object") return;
      openAICompatChatStreamStats.chunks++;
      if (json.usage) {
        openAICompatChatStreamStats.usageChunks++;
        const cachedTokens = openAICompatChatCachedTokens(json);
        if (cachedTokens != null) {
          openAICompatChatStreamStats.cachedTokens = cachedTokens;
        }
      }
      const choices = Array.isArray(json.choices) ? json.choices : [];
      for (const choice of choices) {
        if (choice?.finish_reason != null) {
          openAICompatChatStreamStats.finish = safeLogToken(choice.finish_reason);
        }
        const choiceDelta = choice?.delta;
        if (!choiceDelta || typeof choiceDelta !== "object") continue;
        if (choiceDelta.content != null) {
          openAICompatChatStreamStats.contentDeltas++;
        }
        if (hasReasoningValue(readReasoning(providerKey, choiceDelta))) {
          openAICompatChatStreamStats.reasoningDeltas++;
        }
        const toolCalls = Array.isArray(choiceDelta.tool_calls) ? choiceDelta.tool_calls : [];
        if (toolCalls.length > 0) {
          openAICompatChatStreamStats.toolCallChunks++;
          for (const toolCall of toolCalls) {
            const toolIdentity = toolCall?.id
              || `${choice?.index ?? 0}:${toolCall?.index ?? 0}:${toolCall?.function?.name || ""}`;
            if ((toolCall?.id || toolCall?.function?.name) && !openAICompatChatToolIds.has(toolIdentity)) {
              openAICompatChatToolIds.add(toolIdentity);
              openAICompatChatStreamStats.toolCallStarts++;
            }
            if (toolCall?.function?.arguments != null && String(toolCall.function.arguments) !== "") {
              openAICompatChatStreamStats.toolArgDeltas++;
            }
          }
        }
      }
    }

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
        claudeThinkingCached = true;
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
      const cacheRespIdTag = openaiCompatResponses ? "CACHE_OAI_RESP_ID" : "CACHE_AZ_RESP_ID";
      const skipCacheRespIdTag = openaiCompatResponses ? "SKIP_CACHE_OAI_RESP_ID" : "SKIP_CACHE_AZ_RESP_ID";
      const writeErrorTag = openaiCompatResponses ? "CACHE_OAI_WRITE_ERROR" : "CACHE_AZ_WRITE_ERROR";
      const responseCompleted = terminalOutcome === "completed"
        && azureResponseTerminalStatus === "completed"
        && !requestCancelled;
      if (!responseCompleted) {
        azureRespCached = true;
        if (!azureRespCacheDecisionLogged) {
          azureRespCacheDecisionLogged = true;
          log(skipCacheRespIdTag,
              "key:", azureReplyKey,
              "id:", azureResponseId,
              "status:", azureResponseTerminalStatus || "(none)",
              "outcome:", terminalOutcome,
              "incomplete:", azureResponseIncompleteReason || "(none)");
        }
        return;
      }
      azureRespCached = true;
      log(cacheRespIdTag, "key:", azureReplyKey, "id:", azureResponseId);
      await kvSet(respIdCachePrefix + azureReplyKey, azureResponseId)
        .catch((err) => log(writeErrorTag, err?.message));
    }

    try {
      let currentResponsesEvent = ""; // track event: line for Azure OpenAI Responses SSE
      while (true) {
        let readResult;
        try {
          activePipelineStage = "read";
          readResult = await reader.read();
        } catch (err) {
          noteFailureStage("read");
          throw err;
        }
        const { done, value } = readResult;
        if (done) break;
        readCount++;
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
          // For Azure OpenAI and OpenAI-compatible Responses API, track event:
          // lines to use when processing data: lines — the event name tells us
          // what type of delta it is.
          if ((providerKey === "azureopenai" || openaiCompatResponses) && line.startsWith("event: ")) {
            currentResponsesEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            if (!(providerKey === "azureanthropic" || providerKey === "anthropiccompat" || providerKey === "azureopenai" || openaiCompatResponses)) {
              if (line.trim()) await writeEncoded(encoder.encode(line + "\n"));
            }
            continue;
          }

          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            // Avoid double [DONE] emission when response.completed was already
            // handled above (Azure Responses API may emit both).
            if (doneSeen) continue;
            if (providerKey === "azureopenai" || openaiCompatResponses) {
              setTerminalOutcome("unexpected_eof");
              azureResponseTerminalStatus = azureResponseTerminalStatus || "incomplete";
              diag(openaiCompatResponses ? "OAI_STREAM_UNEXPECTED_EOF" : "AZURE_STREAM_UNEXPECTED_EOF",
                   "provider:", providerKey,
                   "bufferedChars:", 0,
                   "events:", azureEventCounts.total);
              await cacheReasoningSnapshot(true);
              logAzureStreamSummary("unexpected_eof");
              discardDeferredGpt56ToolChunks("unexpected_eof");
              await writeTerminalError({
                message: "Upstream Responses stream ended without a terminal event",
                type: "upstream_error",
                code: "unexpected_eof",
              });
              continue;
            }
            setTerminalOutcome("completed");
            const reasoningChars = reasoningSize(accReasoning);
            log("STREAM_DONE", "reasoning:", reasoningChars, "content:", accContent.length);
            if (reasoningChars > 5000 && accContent.length < 100) {
              log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
            }
            await cacheReasoningSnapshot(true);
            await cacheAzResponseId();
            await cacheClaudeThinking();
            logAzureStreamSummary("[DONE]");
            logOpenAICompatChatStreamSummary("[DONE]");
            await flushDeferredGpt56ToolChunks("done");
            await writeDone();
            continue;
          }
          if (doneSeen) continue;

          try {
            activePipelineStage = "parse";
            let json = JSON.parse(data);
            if (firstEventAt == null) firstEventAt = Date.now();
            activePipelineStage = "map";

            // Transform Anthropic SSE events into OpenAI-compatible format.
            // Anthropic uses events like content_block_delta with delta.text_delta,
            // but the proxy and Cursor expect choices[0].delta.content.
            if (providerKey === "azureanthropic" || providerKey === "anthropiccompat") {
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
                if (doneSeen) continue;
                setTerminalOutcome("completed");
                log("STREAM_DONE_VIA_MESSAGE_STOP", "content:", accContent.length);
                await cacheReasoningSnapshot(true);
                await cacheClaudeThinking();
                await writeDone();
                continue;
              }
              if (!mapped) continue; // skip events that produce no output
              json = mapped;
            }

            // Transform Azure Responses API SSE events into OpenAI-compatible format.
            // Responses API uses named events (event: response.output_text.delta)
            // with data payloads, unlike Anthropic's data-only content_block_delta.
            if ((providerKey === "azureopenai" || openaiCompatResponses) && (currentResponsesEvent || json?.type)) {
              const responsesEvent = json?.type || currentResponsesEvent;
              countAzureEvent(responsesEvent);
              if (responsesEvent === "response.refusal.delta") {
                accRefusal = appendCapped(
                  accRefusal,
                  json?.delta || "",
                  ACC_REFUSAL_CAP,
                  "refusal",
                  () => { refusalCapHit = true; },
                );
              } else if (
                responsesEvent === "response.function_call_arguments.delta" ||
                responsesEvent === "response.custom_tool_call_input.delta" ||
                responsesEvent === "response.apply_patch_call.delta" ||
                responsesEvent === "response.apply_patch_call_input.delta"
              ) {
                azureFunctionDeltaCount++;
              }

              if (responsesEvent === "error") {
                if (doneSeen) continue;
                const upstreamError = json?.error || json;
                const errMessage = upstreamError?.message || upstreamError?.code || "Upstream Responses stream error";
                const errType = upstreamError?.type || "upstream_stream_error";
                const errCode = upstreamError?.code || "responses_stream_error";
                const rateLimited = isRateLimitStreamError(errType, errCode);
                setTerminalOutcome(rateLimited ? "rate_limited" : "failed");
                diag(openaiCompatResponses ? "OAI_STREAM_ERROR" : "AZURE_STREAM_ERROR",
                     "provider:", providerKey,
                     "errorType:", safeLogToken(errType),
                     "errorCode:", safeLogToken(errCode),
                     "hasMessage:", Boolean(upstreamError?.message),
                     "messageChars:", String(upstreamError?.message || "").length);
                azureResponseTerminalStatus = "failed";
                await cacheReasoningSnapshot(true);
                logAzureStreamSummary("error");
                discardDeferredGpt56ToolChunks(rateLimited ? "rate_limited" : "error");
                await reader.cancel().catch(() => {});
                await writeTerminalError({
                  message: errMessage,
                  type: errType,
                  code: errCode,
                });
                continue;
              }

              if (responsesEvent === "response.failed") {
                if (doneSeen) continue;
                const failedResponse = json?.response || {};
                const upstreamError = failedResponse.error || {};
                const errMessage = upstreamError.message
                  || upstreamError.code
                  || "Upstream Responses generation failed";
                const errType = upstreamError.type || "upstream_response_failed";
                const errCode = upstreamError.code || "response_failed";
                const rateLimited = isRateLimitStreamError(errType, errCode);
                setTerminalOutcome(rateLimited ? "rate_limited" : "failed");
                azureResponseTerminalStatus = failedResponse.status || "failed";
                diag(openaiCompatResponses ? "OAI_RESPONSE_FAILED" : "AZURE_RESPONSE_FAILED",
                     "provider:", providerKey,
                     "status:", azureResponseTerminalStatus,
                     "errorType:", safeLogToken(errType),
                     "errorCode:", safeLogToken(errCode),
                     "hasMessage:", Boolean(upstreamError.message),
                     "messageChars:", String(upstreamError.message || "").length);
                await cacheReasoningSnapshot(true);
                logAzureStreamSummary("response.failed");
                discardDeferredGpt56ToolChunks(rateLimited ? "rate_limited" : "response_failed");
                await reader.cancel().catch(() => {});
                await writeTerminalError({
                  message: errMessage,
                  type: errType,
                  code: errCode,
                });
                continue;
              }

              if (isResponsesToolDoneEvent(responsesEvent)) {
                const state = responsesToolStateForLog(responsesToolState, json);
                const argsText = responsesToolArgsForLog(json, state);
                const toolName = state?.name || json?.name || "(unknown)";
                diag(openaiCompatResponses ? "OAI_TOOL_CALL_DONE" : "AZURE_TOOL_CALL_DONE",
                     "provider:", providerKey,
                     "name:", safeLogToken(toolName),
                     "toolIndex:", state?.toolIndex ?? "(none)",
                     "responsesIndex:", json?.output_index ?? "(none)",
                     "argChars:", argsText.length,
                     "argKeys:", summarizeJsonArgKeysForLog(argsText));
                log(openaiCompatResponses ? "OAI_TOOL_ARG_SHAPE" : "AZURE_TOOL_ARG_SHAPE",
                    "provider:", providerKey,
                    "name:", safeLogToken(toolName),
                    "toolIndex:", state?.toolIndex ?? "(none)",
                    "responsesIndex:", json?.output_index ?? "(none)",
                    ...summarizeToolArgShapeForLog(toolName, argsText));
              }

              let mapped = null;
              let finalToolArgsText = null;
              const preMappedToolState = responsesToolStateForLog(responsesToolState, json);
              const shouldSanitizeSubagentArgs = openaiCompatResponses
                && isCursorSubagentToolName(preMappedToolState?.name || json?.name);
              const shouldSanitizeTaskArgs = openaiCompatResponses
                && upstreamModelName === "gpt-5.6-sol"
                && isCursorTaskToolName(preMappedToolState?.name || json?.name);
              const shouldSanitizeShellArgs = openaiCompatResponses
                && isCursorShellToolName(preMappedToolState?.name || json?.name);
              const shouldSanitizeGetMcpToolsArgs = openAICompatResponsesHaloCompatibleCache
                && isCursorGetMcpToolsName(preMappedToolState?.name || json?.name);

              if (
                (shouldSanitizeSubagentArgs || shouldSanitizeTaskArgs || shouldSanitizeShellArgs || shouldSanitizeGetMcpToolsArgs)
                && isResponsesToolArgDeltaEvent(responsesEvent)
              ) {
                // Let mapResponsesSSEToOpenAI update partialJson, then suppress
                // the raw delta so Cursor never sees args that need local repair.
                mapResponsesSSEToOpenAI(responsesEvent, json, responsesToolState);
                continue;
              }

              const shouldRepairDefaultToolDoneArgs = openaiCompatResponses
                && !openAICompatSub2ApiCache
                && !shouldSanitizeSubagentArgs
                && !shouldSanitizeTaskArgs
                && !shouldSanitizeShellArgs
                && !shouldSanitizeGetMcpToolsArgs
                && isResponsesToolDoneEvent(responsesEvent);

              if (shouldSanitizeTaskArgs && isResponsesToolDoneEvent(responsesEvent)) {
                const argsText = responsesToolArgsForLog(json, preMappedToolState);
                const sanitized = sanitizeCursorTaskArgs(argsText);
                finalToolArgsText = sanitized.argsText;
                if (sanitized.removed.length > 0) {
                  diag("OAI_TASK_ARGS_SANITIZED",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "toolIndex:", preMappedToolState?.toolIndex ?? "(none)",
                       "removed:", sanitized.removed.map((key) => safeLogToken(key)).join(","),
                       "argKeys:", summarizeJsonArgKeysForLog(sanitized.argsText));
                } else if (sanitized.parseError) {
                  diag("OAI_TASK_ARGS_SANITIZE_SKIP",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "reason:", "unparseable");
                }
                mapped = mapResponsesToolArgsContinuationForProxy(
                  preMappedToolState,
                  sanitized.argsText,
                );
              } else if (shouldSanitizeSubagentArgs && isResponsesToolDoneEvent(responsesEvent)) {
                const argsText = responsesToolArgsForLog(json, preMappedToolState);
                const sanitized = sanitizeCursorSubagentArgsForLocal(argsText);
                finalToolArgsText = sanitized.argsText;
                if (sanitized.removed.length > 0) {
                  diag("OAI_SUBAGENT_ARGS_SANITIZED",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "toolIndex:", preMappedToolState?.toolIndex ?? "(none)",
                       "removed:", sanitized.removed.map((key) => safeLogToken(key)).join(","),
                       "argKeys:", summarizeJsonArgKeysForLog(sanitized.argsText));
                } else if (sanitized.parseError) {
                  diag("OAI_SUBAGENT_ARGS_SANITIZE_SKIP",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "reason:", "unparseable");
                }
                mapped = mapResponsesToolArgsChunkForProxy(preMappedToolState, sanitized.argsText);
              } else if (shouldSanitizeShellArgs && isResponsesToolDoneEvent(responsesEvent)) {
                const argsText = responsesToolArgsForLog(json, preMappedToolState);
                const sanitized = sanitizeCursorShellArgsForLocal(argsText);
                finalToolArgsText = sanitized.argsText;
                if (sanitized.removed.length > 0) {
                  diag("OAI_SHELL_ARGS_SANITIZED",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "toolIndex:", preMappedToolState?.toolIndex ?? "(none)",
                       "removed:", sanitized.removed.map((key) => safeLogToken(key)).join(","),
                       "reason:", "empty_pattern",
                       "argKeys:", summarizeJsonArgKeysForLog(sanitized.argsText));
                } else if (sanitized.parseError) {
                  diag("OAI_SHELL_ARGS_SANITIZE_SKIP",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "reason:", "unparseable");
                }
                const shouldMapArgumentsOnlyContinuation = upstreamModelName === "gpt-5.6-sol"
                  && responsesEvent === "response.function_call_arguments.done"
                  && preMappedToolState
                  && Number.isInteger(preMappedToolState.toolIndex);
                mapped = shouldMapArgumentsOnlyContinuation
                  ? mapResponsesToolArgsContinuationForProxy(preMappedToolState, sanitized.argsText)
                  : mapResponsesToolArgsChunkForProxy(preMappedToolState, sanitized.argsText);
              } else if (shouldSanitizeGetMcpToolsArgs && isResponsesToolDoneEvent(responsesEvent)) {
                const argsText = responsesToolArgsForLog(json, preMappedToolState);
                const sanitized = sanitizeCursorGetMcpToolsArgs(argsText, {
                  repairConflictingSelectors: openAICompatResponsesHaloCache,
                });
                finalToolArgsText = sanitized.argsText;
                if (sanitized.removed.length > 0) {
                  diag("OAI_GET_MCP_TOOLS_ARGS_SANITIZED",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "toolIndex:", preMappedToolState?.toolIndex ?? "(none)",
                       "removed:", sanitized.removed.map((key) => safeLogToken(key)).join(","),
                       "argKeys:", summarizeJsonArgKeysForLog(sanitized.argsText));
                } else if (sanitized.parseError) {
                  diag("OAI_GET_MCP_TOOLS_ARGS_SANITIZE_SKIP",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "reason:", "unparseable");
                }
                mapped = mapResponsesToolArgsChunkForProxy(preMappedToolState, sanitized.argsText);
              } else if (shouldRepairDefaultToolDoneArgs) {
                mapped = mapMissingResponsesToolArgsForProxy(
                  preMappedToolState,
                  responsesToolArgsForLog(json, preMappedToolState),
                );
              } else {
                mapped = mapResponsesSSEToOpenAI(responsesEvent, json, responsesToolState);
              }
              if (isResponsesToolDoneEvent(responsesEvent)) {
                const finalizedToolState = finalizeResponsesToolState(
                  preMappedToolState,
                  responsesEvent,
                  finalToolArgsText ?? responsesToolArgsForLog(json, preMappedToolState),
                  {
                    validateFinalArgs: shouldSanitizeShellArgs
                      ? validateCursorShellArgs
                      : undefined,
                  },
                );
                if (
                  shouldSanitizeShellArgs
                  && finalizedToolState
                  && !finalizedToolState.finalArgsValid
                ) {
                  diag("OAI_SHELL_ARGS_INVALID",
                       "provider:", providerKey,
                       "name:", safeLogToken(finalizedToolState.name || json?.name || "(unknown)"),
                       "toolIndex:", finalizedToolState.toolIndex ?? "(none)",
                       "reason:", safeLogToken(finalizedToolState.finalArgsInvalidReason || "invalid_arguments"),
                       "argKeys:", summarizeJsonArgKeysForLog(
                         finalToolArgsText ?? responsesToolArgsForLog(json, preMappedToolState),
                       ));
                }
              }

              if (mapped) {
                const mappedToolCalls = mapped.choices?.[0]?.delta?.tool_calls;
                if (mappedToolCalls) {
                  responsesToolCallSeen = true;
                  if (responsesEvent === "response.output_item.added") {
                    const firstTool = mappedToolCalls[0] || {};
                    diag(openaiCompatResponses ? "OAI_TOOL_CALL_START" : "AZURE_TOOL_CALL_START",
                         "provider:", providerKey,
                         "name:", safeLogToken(firstTool.function?.name || "(unknown)"),
                         "toolIndex:", firstTool.index ?? "(none)",
                         "responsesIndex:", json?.output_index ?? "(none)");
                  }
                }

                const firstMappedTool = mappedToolCalls?.[0];
                const mappedToolIndex = firstMappedTool?.index;
                const isGpt56ShellStart = bufferGpt56ToolChunks
                  && responsesEvent === "response.output_item.added"
                  && isCursorShellToolName(firstMappedTool?.function?.name)
                  && Number.isInteger(mappedToolIndex);
                if (isGpt56ShellStart && pendingGpt56ShellToolIndex == null) {
                  pendingGpt56ShellToolIndex = mappedToolIndex;
                }
                if (
                  bufferGpt56ToolChunks
                  && Number.isInteger(mappedToolIndex)
                ) {
                  deferredGpt56ToolChunks.push({
                    chunk: mapped,
                    order: deferredGpt56ToolChunks.length,
                    toolIndex: mappedToolIndex,
                  });
                  continue;
                }
                json = mapped;
              } else {
                // Capture the response ID from the first SSE event so we can
                // write it to KV and enable previous_response_id chaining on
                // the next turn.
                if (responsesEvent === "response.created" && !azureResponseId) {
                  azureResponseId = json?.response?.id || null;
                  if (azureResponseId) {
                    log(openaiCompatResponses ? "STREAM_OAI_RESP_ID" : "STREAM_AZ_RESP_ID", "id:", azureResponseId);
                  }
                }
                // Emit downstream [DONE] when the Responses API signals completion.
                // Cursor expects OpenAI Chat Completions stream semantics, which
                // always terminate with data: [DONE].  Without this, a stream that
                // ends via response.completed (no raw [DONE] line) looks hung.
                if (responsesEvent === "response.completed") {
                  if (doneSeen) continue;
                  const completed = json?.response || {};
                  azureResponseTerminalStatus = completed.status || "completed";
                  const terminalDiagnosticArgs = [
                    "status:", completed.status || azureResponseTerminalStatus,
                  ];
                  const terminalError = completed.error?.code || completed.error?.message;
                  if (terminalError) {
                    terminalDiagnosticArgs.push("error:", terminalError);
                  }
                  diag("AZURE_RESPONSE_COMPLETED", ...terminalDiagnosticArgs);
                  log("STREAM_DONE_VIA_RESPONSE_COMPLETED", "content:", accContent.length);
                  if (azureResponseTerminalStatus !== "completed") {
                    setTerminalOutcome("failed");
                    discardDeferredGpt56ToolChunks("response_not_completed");
                    logAzureStreamSummary("response_not_completed");
                    await writeTerminalError({
                      message: "Upstream response did not complete successfully",
                      type: completed.error?.type || "upstream_response_failed",
                      code: completed.error?.code || "response_not_completed",
                    });
                    continue;
                  }
                  const allToolStates = uniqueResponsesToolStates(responsesToolState);
                  const incompleteToolStates = incompleteResponsesToolStates(responsesToolState);
                  if (incompleteToolStates.length > 0) {
                    const firstIncompleteTool = incompleteToolStates[0];
                    const missingFinalCount = incompleteToolStates.filter(
                      (state) => !state.finalArgsReceived,
                    ).length;
                    const invalidFinalCount = incompleteToolStates.length - missingFinalCount;
                    diag(openaiCompatResponses ? "OAI_TOOL_CALL_INCOMPLETE" : "AZURE_TOOL_CALL_INCOMPLETE",
                         "provider:", providerKey,
                         "name:", safeLogToken(firstIncompleteTool.name || "(unknown)"),
                         "toolIndex:", firstIncompleteTool.toolIndex ?? "(none)",
                         "started:", allToolStates.length,
                         "incomplete:", incompleteToolStates.length,
                         "missingFinal:", missingFinalCount,
                         "invalidFinal:", invalidFinalCount);
                    setTerminalOutcome("incomplete_tool_call");
                    discardDeferredGpt56ToolChunks("incomplete_tool_call");
                    await writeTerminalError({
                      message: "Upstream response completed with an unfinished tool call",
                      type: "incomplete_tool_call",
                      code: "incomplete_tool_call",
                    });
                    continue;
                  }
                  await cacheReasoningSnapshot(true);
                  logAzureStreamSummary(responsesEvent);
                  await flushDeferredGpt56ToolChunks("terminal");
                  if (responsesStreamIncludeUsage && completed.usage) {
                    const usage = mapResponsesUsageToOpenAI(completed.usage);
                    if (usage) {
                      const usageChunk = withPublicResponseModel({
                        id: completed.id || azureResponseId || "resp_unknown",
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: completed.model || "",
                        choices: [],
                        usage,
                      }, responseModelName, aliasApplied);
                      await writeEncoded(encoder.encode(
                        "data: " + JSON.stringify(stripResponseChunk(usageChunk)) + "\n\n"
                      ));
                    }
                  }
                  if (responsesToolCallSeen) {
                    const finishChunk = withPublicResponseModel({
                      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                    }, responseModelName, aliasApplied);
                    await writeEncoded(encoder.encode(
                      "data: " + JSON.stringify(stripResponseChunk(finishChunk)) + "\n\n"
                    ));
                  }
                  await writeDone();
                  if (azureResponseTerminalStatus === "completed") {
                    setTerminalOutcome("completed");
                  } else {
                    setTerminalOutcome("failed");
                  }
                }
                if (responsesEvent === "response.incomplete") {
                  if (doneSeen) continue;
                  setTerminalOutcome("incomplete");
                  const incompleteResponse = json?.response || {};
                  azureResponseTerminalStatus = incompleteResponse.status || "incomplete";
                  azureResponseIncompleteReason = incompleteResponse.incomplete_details?.reason || null;
                  const incompleteReason = azureResponseIncompleteReason || "unknown";
                  diag("AZURE_RESPONSE_INCOMPLETE",
                       "status:", azureResponseTerminalStatus,
                       "incomplete:", incompleteReason);
                  if (openaiCompatResponses) {
                    diag("OAI_RESPONSE_INCOMPLETE",
                         "provider:", providerKey,
                         "status:", azureResponseTerminalStatus,
                         "reason:", safeLogToken(incompleteReason));
                  }
                  log("STREAM_DONE_VIA_RESPONSE_INCOMPLETE", "content:", accContent.length);
                  await cacheReasoningSnapshot(true);
                  logAzureStreamSummary("response.incomplete");
                  discardDeferredGpt56ToolChunks("response_incomplete");
                  await reader.cancel().catch(() => {});
                  await writeTerminalError({
                    message: `Upstream response was incomplete: ${incompleteReason}`,
                    type: "incomplete_response",
                    code: "response_incomplete",
                  });
                }
                continue; // skip events that produce no output
              }
            }

            if (openAICompatChatCacheUsageFacade) {
              const cacheUsage = normalizeOpenAICompatChatCacheUsage(json);
              json = cacheUsage.json;
              if (cacheUsage.changed) {
                diag("OAI_CHAT_CACHE_STREAM_USAGE",
                     "provider:", providerKey,
                     "model:", safeLogToken(upstreamModelName || json?.model || ""),
                     "cached_tokens:", cacheUsage.cachedTokens);
              }
            }

            updateOpenAICompatChatStreamStats(json);
            const delta = json.choices?.[0]?.delta;
            const chunkReasoning = readReasoning(providerKey, delta);
            accReasoning = updateStreamReasoning(providerKey, accReasoning, chunkReasoning);
            // Soft cap: DeepSeek/Kimi/GLM accumulate reasoning as a single
            // growing string; MiniMax replaces the object wholesale so already bounded.
            // We truncate the stored string but keep forwarding the SSE chunk
            // unchanged so clients still receive every token from upstream.
            if (typeof accReasoning === "string" && accReasoning.length > ACC_REASONING_CAP) {
              log("STREAM_ACC_CAP_REACHED", "label:", "reasoning", "cap:", ACC_REASONING_CAP);
              accReasoning = accReasoning.slice(0, ACC_REASONING_CAP);
            }
            if (hasReasoningValue(chunkReasoning)) {
              await cacheReasoningSnapshot();
            }
            if (delta?.content != null) {
              accContent = appendCapped(
                accContent,
                String(delta.content),
                ACC_CONTENT_CAP,
                "content",
                () => { contentCapHit = true; },
              );
            }
            json = withPublicResponseModel(json, responseModelName, forcePublicModel);
            await writeEncoded(
              encoder.encode(
                "data: " + JSON.stringify(stripResponseChunk(json)) + "\n\n"
              )
            );
          } catch (err) {
            if (err?.name === "DownstreamWriteError") {
              noteFailureStage("write");
              const clientCancelled = requestSignal?.aborted === true;
              if (clientCancelled) {
                requestCancelled = true;
                setTerminalOutcome("cancelled");
              } else {
                setTerminalOutcome("write_error");
              }
              azureResponseTerminalStatus = azureResponseTerminalStatus || "failed";
              discardDeferredGpt56ToolChunks(clientCancelled ? "cancelled" : "write_error");
              logStreamWriteError({
                stage: "write",
                error: err.cause,
                cancelled: clientCancelled,
              });
              await reader.cancel(err.cause).catch(() => {});
              throw err;
            }
            if (terminalOutcome !== "open") {
              noteFailureStage(activePipelineStage);
              throw err;
            }
            if (openAICompatChatStreamDiag) {
              openAICompatChatStreamStats.parseErrors++;
            }
            if (providerKey === "azureopenai" || openaiCompatResponses) {
              const failureStage = activePipelineStage === "read"
                ? "pipeline"
                : activePipelineStage;
              noteFailureStage(failureStage);
              const eventType = safeLogToken(currentResponsesEvent || "unknown");
              diag(openaiCompatResponses ? "OAI_STREAM_PIPELINE_FAILURE" : "AZURE_STREAM_PIPELINE_FAILURE",
                   "stage:", failureStage,
                   "event:", eventType,
                   "errorType:", safeLogToken(err?.name || "Error"),
                   "messageChars:", String(err?.message || "").length);
              setTerminalOutcome("pipeline_error");
              azureResponseTerminalStatus = azureResponseTerminalStatus || "failed";
              discardDeferredGpt56ToolChunks("pipeline_error");
              await reader.cancel(err).catch(() => {});
              await writeTerminalError({
                message: "Upstream Responses stream contained an invalid event",
                type: "upstream_error",
                code: `stream_${failureStage}_error`,
              });
              continue;
            }
            try {
              await writeEncoded(encoder.encode(line + "\n\n"));
            } catch (writeError) {
              noteFailureStage("write");
              throw writeError;
            }
          }
        }
      }

      buffer += decoder.decode();
      if (
        (providerKey === "azureopenai" || openaiCompatResponses)
        && terminalOutcome === "open"
      ) {
        setTerminalOutcome("unexpected_eof");
        azureResponseTerminalStatus = azureResponseTerminalStatus || "incomplete";
        diag(openaiCompatResponses ? "OAI_STREAM_UNEXPECTED_EOF" : "AZURE_STREAM_UNEXPECTED_EOF",
             "provider:", providerKey,
             "bufferedChars:", buffer.trim().length,
             "events:", azureEventCounts.total);
        logAzureStreamSummary("unexpected_eof");
        discardDeferredGpt56ToolChunks("unexpected_eof");
        await writeTerminalError({
          message: "Upstream Responses stream ended without a terminal event",
          type: "upstream_error",
          code: "unexpected_eof",
        });
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
        log("STREAM_READ_ABORTED_AFTER_TIMEOUT",
            "type:", safeLogToken(err?.name || "Error"),
            "messageChars:", String(err?.message || "").length);
      } else if (requestCancelled) {
        log("STREAM_CANCELLED", "provider:", providerKey, "stage:", "read");
      } else if (terminalOutcome === "pipeline_error") {
        diag("STREAM_PIPELINE_ERROR",
             "stage:", failureStage,
             "type:", safeLogToken(err?.name || "Error"),
             "messageChars:", String(err?.message || "").length);
      } else if (terminalOutcome === "write_error") {
        log("STREAM_WRITE_ABORTED", "provider:", providerKey);
      } else {
        setTerminalOutcome("read_error");
        noteFailureStage("read");
        azureResponseTerminalStatus = azureResponseTerminalStatus || "failed";
        streamReadError = true;
        diag("STREAM_READ_ERROR",
             "type:", safeLogToken(err?.name || "Error"),
             "messageChars:", String(err?.message || "").length);
        try {
          discardDeferredGpt56ToolChunks("read_error");
          await writeTerminalError({
            message: `Upstream stream interrupted: ${err?.message || err?.name || "unknown error"}`,
            type: "upstream_error",
            code: "stream_read_error",
          });
        } catch {}
      }
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      requestSignal?.removeEventListener("abort", cancelFromRequest);

      if (timedOut) {
        noteFailureStage("timeout");
        const reasoningChars = reasoningSize(accReasoning);
        diag("STREAM_TIMEOUT", "reasoning:", reasoningChars, "content:", accContent.length,
            "timeout:", effectiveTimeoutSec + "s");
        if (reasoningChars > 5000 && accContent.length < 100) {
          log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
        }
        try {
          discardDeferredGpt56ToolChunks("timeout");
          const timeoutMsg = JSON.stringify({
            error: {
              message: `Stream timed out after ${effectiveTimeoutSec}s. The model was still generating (reasoning: ${reasoningChars} chars, content: ${accContent.length} chars). Retry with a smaller prompt, or increase STREAM_TIMEOUT_SECONDS.`,
              type: "stream_timeout",
              code: "stream_timeout",
            },
          });
          await writeEncoded(encoder.encode("data: " + timeoutMsg + "\n\n"));
          await writeDone();
        } catch {}
      }

      if (requestCancelled) {
        noteFailureStage("cancel");
        if (!doneSeen) {
          try {
            discardDeferredGpt56ToolChunks("cancelled");
            await writeTerminalError({
              message: "Client cancelled the streaming request",
              type: "request_cancelled",
              code: "request_cancelled",
            });
          } catch {}
        }
      }
      if (
        !doneSeen
        && terminalOutcome === "open"
        && originalMessages
        && hasReasoningValue(accReasoning)
      ) {
        const reasoningChars = reasoningSize(accReasoning);
        log("STREAM_FINALLY", "reasoning:", reasoningChars, "content:", accContent.length);
        if (reasoningChars > 5000 && accContent.length < 100) {
          log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
        }
        await cacheReasoningSnapshot(true);
      }

      try {
        await writer.close();
      } catch (err) {
        noteFailureStage("write");
        if (requestSignal?.aborted === true) {
          requestCancelled = true;
          terminalOutcome = "cancelled";
        } else if (terminalOutcome === "open" || terminalOutcome === "completed") {
          terminalOutcome = "write_error";
        }
        terminalAt = Date.now();
        discardDeferredGpt56ToolChunks(requestCancelled ? "cancelled" : "write_error");
        await reader.cancel(err).catch(() => {});
        logStreamWriteError({
          stage: "close",
          error: err,
          cancelled: requestCancelled,
        });
      }

      // Response IDs are replayable only after an explicit successful terminal
      // event and downstream finalization. cacheAzResponseId() records a skip
      // for every other outcome.
      await cacheAzResponseId();
      if (terminalOutcome === "completed") await cacheClaudeThinking();
      if ((providerKey === "azureanthropic" || providerKey === "anthropiccompat") && anthropicEventCounts.total > 0) {
        log("ANTHROPIC_EVENTS", anthropicEventCounts);
      }
      logAzureStreamSummary(timedOut ? "timeout" : "finally");
      logOpenAICompatChatStreamSummary(timedOut ? "timeout" : (streamReadError ? "read_error" : "finally"));
      logLifecycle();
      diag("RES", upstreamRes.status, "provider:", providerKey, "ms:", Date.now() - t0);
    }
  })().catch((err) => {
    // Last-resort guard: ensure no rejection escapes the unawaited IIFE.
    // Anything reaching here means the inner try/catch/finally itself threw
    // (e.g. writer.close() race after cancel). Logging only — the response
    // stream has already been returned to the client.
    if (terminalOutcome === "open") {
      terminalOutcome = "pipeline_error";
      terminalAt = Date.now();
    }
    diag("STREAM_PIPE_ERROR",
         "stage:", "finalize",
         "type:", safeLogToken(err?.name || "Error"),
         "messageChars:", String(err?.message || "").length);
  });

  const downstreamReadable = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await downstreamReader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await Promise.all([
        downstreamReader.cancel(reason).catch(() => {}),
        cancelDownstreamResponse?.(reason),
      ]);
    },
  });

  return new Response(downstreamReadable, {
    status: upstreamRes.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
