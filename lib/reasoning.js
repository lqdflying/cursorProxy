import { kvGet, kvSet } from "./kv.js";
import { createLogger } from "./logger.js";

const { log, diag } = createLogger("reasoning");
const { diag: proxyDiag } = createLogger("proxy");

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

function contentLogSummary(content) {
  if (typeof content === "string") return `string:${content.length}`;
  if (Array.isArray(content)) return `array:${content.length}`;
  if (content == null) return "none";
  return typeof content;
}

async function injectStoredReasoning({
  providerKey,
  parsedBody,
  originalMessages,
  scope,
  conversationHash,
  minAssistantIndex = 0,
}) {
  // Inject stored reasoning into ALL prior assistant messages by position.
  //
  // DeepSeek/Kimi thinking mode REQUIRES reasoning_content on every prior
  // assistant turn (including tool-calling ones) - otherwise it returns:
  //   "The `reasoning_content` in the thinking mode must be passed back to the API."
  // When KV has nothing for a given turn (e.g. trivial greeting that produced no
  // thinking, or a turn not proxied through us, or KV race), we still inject a
  // placeholder so the field is present and the provider accepts the request.
  //
  // GLM/Z.AI Coding Plan also supports preserved reasoning_content, but its docs
  // require prior reasoning to be returned complete and unmodified. On KV miss,
  // leave the assistant message unchanged instead of fabricating a placeholder.
  //
  // Skip for providers that don't support reasoning fields:
  // - Anthropic's Messages API rejects `reasoning_content` (Extra inputs not permitted)
  // - Azure OpenAI's Chat Completions API may also reject it on certain models
  const reasoningProviders = new Set(["deepseek", "kimi", "minimax", "mimo", "glm", "fireworks"]);
  let injectedCount = 0;
  let missedCount = 0;
  if (originalMessages && reasoningProviders.has(providerKey)) {
    const messages = parsedBody.messages;
    const assistantIndices = messages
      .map((m, i) => i)
      .filter((i) =>
        i >= minAssistantIndex &&
        messages[i].role === "assistant" &&
        !hasReasoningField(providerKey, messages[i])
      );

    const fetched = await Promise.all(
      assistantIndices.map(async (i) => {
        const key = await conversationHash(originalMessages, i, scope);
        const result = await waitForStoredReasoning(providerKey, key);
        return { i, key, ...result };
      })
    );

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
        // Never fabricate reasoning for providers where some models don't
        // support it.  GLM docs require prior reasoning to be returned
        // complete and unmodified; Fireworks hosts models with disabled
        // reasoning (e.g. qwen3-...-no-thinking, reasoning_effort: "none",
        // thinking: { type: "disabled" }) that would receive a spurious
        // "(prior reasoning unavailable)" placeholder.  Both use hit-only
        // restoration: restore what we cached, skip if we missed.
        if (providerKey === "glm" || providerKey === "fireworks") {
          missedCount++;
          continue;
        }
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
      }
    }
    log("INJECT_SUMMARY", "turns:", assistantIndices.length, "hits:", injectedCount, "misses:", missedCount, "recovered:", recoveredCount);
    if (assistantIndices.length > 0) {
      proxyDiag("INJECT_SUMMARY", "turns:", assistantIndices.length, "hits:", injectedCount, "misses:", missedCount, "recovered:", recoveredCount);
    }
    if (recoveredCount > 0) proxyDiag("INJECT_RECOVERED", "count:", recoveredCount, "of:", fetched.length);
    if (missedCount > 0) proxyDiag("INJECT_MISS", "missed:", missedCount, "of:", fetched.length);
  }

  return { parsedBody, injectedCount, missedCount };
}

// Extract thinking blocks from a non-streaming Azure Claude response.
// Returns array of {type:"thinking", thinking:"..."} blocks, or null if none found.
// Includes redacted_thinking blocks and thinking blocks that only carry a signature
// (empty thinking + signature).  Anthropic docs explicitly warn that filtering only
// thinking.thinking breaks round-tripping for redacted or signature-only blocks.
function extractClaudeThinkingBlocks(responseJson) {
  if (!responseJson?.content || !Array.isArray(responseJson.content)) return null;
  const blocks = responseJson.content.filter(
    (b) => b?.type === "redacted_thinking" ||
      (b?.type === "thinking" && (b.thinking || b.signature))
  );
  return blocks.length > 0 ? blocks : null;
}

// Inject cached Claude thinking blocks into ALL prior assistant messages
// that have string content (non-tool turns). Tool-using assistants already
// have array content; thinking blocks are prepended to the existing array.
// Returns count of messages injected.
async function injectClaudeThinkingBlocks(parsedBody, originalMessages, scope, conversationHash, normalizedConversationHash) {
  const messages = parsedBody.messages;
  if (!messages) return 0;

  const assistantIndices = messages
    .map((m, i) => i)
    .filter((i) => {
      const msg = messages[i];
      if (msg.role !== "assistant") return false;
      // Skip messages that already have multi-block content with a thinking
      // or redacted_thinking block (already injected, or preserved from a prior
      // non-streaming response).  Re-injecting would duplicate the content.
      if (Array.isArray(msg.content)) {
        const hasThinking = msg.content.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking");
        if (hasThinking) return false;
      }
      return true;
    });

  if (assistantIndices.length === 0) return 0;

  const fetched = await Promise.all(
    assistantIndices.map(async (i) => {
      const key = await normalizedConversationHash(originalMessages, i, scope);
      const raw = await kvGet("claude_thinking:" + key);
      const hit = raw != null;
      log("CLAUDE_THINKING_LOOKUP", "idx:", i, "key:", key, "hit:", hit);
      diag("CLAUDE_THINKING_LOOKUP_SOURCE",
           "idx:", i,
           "hashInputCount:", i,
           "roles:", originalMessages.slice(0, i).map((m, j) => `${j}:${m.role || "?"}`).join(","));
      return { i, key, raw, hit };
    })
  );

  let injectedCount = 0;
  for (const { i, key, raw, hit } of fetched) {
    if (!hit) {
      diag("CLAUDE_THINKING_MISS", "idx:", i, "key:", key);
      continue;
    }
    let blocks;
    try { blocks = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(blocks) || blocks.length === 0) continue;

    const currentContent = messages[i].content;
    if (Array.isArray(currentContent)) {
      messages[i].content = [...blocks, ...currentContent];
    } else {
      messages[i].content = [...blocks, { type: "text", text: String(currentContent || "") }];
    }
    injectedCount++;
    diag("CLAUDE_THINKING_INJECTED", "idx:", i, "key:", key, "blocks:", blocks.length);
  }
  return injectedCount;
}

export {
  extractClaudeThinkingBlocks,
  hasReasoningValue,
  injectClaudeThinkingBlocks,
  injectStoredReasoning,
  readReasoning,
  reasoningField,
  reasoningSize,
  serializeReasoning,
  stripResponseChunk,
  updateStreamReasoning,
};
