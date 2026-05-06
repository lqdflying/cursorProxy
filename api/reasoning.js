import { kvGet, kvSet } from "./kv.js";
import { createLogger } from "./logger.js";

const { log } = createLogger("reasoning");

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

async function injectStoredReasoning({
  providerKey,
  parsedBody,
  originalMessages,
  scope,
  conversationHash,
}) {
  // Inject stored reasoning into ALL prior assistant messages by position.
  //
  // DeepSeek thinking mode REQUIRES reasoning_content on every prior assistant
  // turn (including tool-calling ones) — otherwise it returns:
  //   "The `reasoning_content` in the thinking mode must be passed back to the API."
  // When KV has nothing for a given turn (e.g. trivial greeting that produced no
  // thinking, or a turn not proxied through us, or KV race), we still inject a
  // placeholder so the field is present and the provider accepts the request.
  //
  // Skip for providers that don't support reasoning fields:
  // - Anthropic's Messages API rejects `reasoning_content` (Extra inputs not permitted)
  // - Azure OpenAI's Chat Completions API may also reject it on certain models
  const reasoningProviders = new Set(["deepseek", "kimi", "minimax"]);
  let injectedCount = 0;
  if (originalMessages && reasoningProviders.has(providerKey)) {
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
  }

  return { parsedBody, injectedCount };
}

export {
  hasReasoningValue,
  injectStoredReasoning,
  readReasoning,
  reasoningField,
  reasoningSize,
  serializeReasoning,
  stripResponseChunk,
  updateStreamReasoning,
};
