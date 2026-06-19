import { allowedEnvValue } from "./auth.js";
import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

const GLM_ALLOWED_PARAMS = new Set([
  "model",
  "messages",
  "stream",
  "thinking",
  "reasoning_effort",
  "temperature",
  "top_p",
  "max_tokens",
  "tools",
  "tool_choice",
  "tool_stream",
  "stop",
  "response_format",
  "request_id",
  "user_id",
]);

// Per Z.AI / ZHIPU AI docs, only GLM-5.2+ accepts reasoning_effort. Sending
// it to older GLM models (4.5/4.6/4.7/5/5.1) is rejected upstream.
// Allowed values: max (default), xhigh, high, medium, low, minimal, none.
const GLM_REASONING_EFFORTS = new Set([
  "max", "xhigh", "high", "medium", "low", "minimal", "none",
]);
const GLM_DEFAULT_EFFORT = "max";

function normalizeBareModel(bareModel) {
  return typeof bareModel === "string" ? bareModel.trim().toLowerCase() : "";
}

export function isGlmModel(bareModel) {
  return normalizeBareModel(bareModel).startsWith("glm");
}

// Detect GLM-5.2+ so reasoning_effort is forwarded upstream. Uses numeric
// comparison so any future version (5.10, 5.99, 6.0, 50.3, ...) classifies
// correctly. Rejects older 4.x/5/5.1 and the glm-5v-turbo vision model
// (no '.' minor after the major, so minor stays 0).
function isGlm52PlusModel(bareModel) {
  const m = normalizeBareModel(bareModel);
  const match = /^glm-(\d+)(?:\.(\d+))?(?:[-.]|$)/.exec(m);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  return major > 5 || (major === 5 && minor >= 2);
}

function normalizeModel(parsedBody) {
  if (!isGlmModel(parsedBody.model)) return false;
  const next = parsedBody.model.trim().toLowerCase();
  if (parsedBody.model === next) return false;
  parsedBody.model = next;
  return true;
}

function stripUnsupportedParams(parsedBody) {
  let changed = false;
  for (const key of Object.keys(parsedBody)) {
    if (GLM_ALLOWED_PARAMS.has(key)) continue;
    delete parsedBody[key];
    changed = true;
  }
  return changed;
}

function normalizeMaxTokens(parsedBody) {
  let changed = false;

  if (parsedBody.max_tokens == null && parsedBody.max_completion_tokens != null) {
    parsedBody.max_tokens = parsedBody.max_completion_tokens;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(parsedBody, "max_completion_tokens")) {
    delete parsedBody.max_completion_tokens;
    changed = true;
  }

  return changed;
}

function normalizeToolChoice(parsedBody) {
  const tc = parsedBody.tool_choice;
  if (tc == null || tc === "auto") return false;

  if (tc === "none") {
    delete parsedBody.tool_choice;
    delete parsedBody.tools;
    delete parsedBody.tool_stream;
    diag("GLM_TOOL_CHOICE_FIXED", "from:", "none", "to:", "tools_removed");
    return true;
  }

  parsedBody.tool_choice = "auto";
  diag("GLM_TOOL_CHOICE_FIXED", "from:", JSON.stringify(tc), "to:", "auto");
  return true;
}

function enableToolStreaming(parsedBody) {
  if (parsedBody.stream !== true) return false;
  if (!Array.isArray(parsedBody.tools) || parsedBody.tools.length === 0) return false;
  if (Object.prototype.hasOwnProperty.call(parsedBody, "tool_stream")) return false;

  parsedBody.tool_stream = true;
  return true;
}

function injectThinking(parsedBody) {
  if (Object.prototype.hasOwnProperty.call(parsedBody, "thinking")) return false;

  parsedBody.thinking = { type: "enabled", clear_thinking: false };
  return true;
}

// Resolve reasoning_effort for GLM requests. Mutates parsedBody in place and
// returns { source, changed } for the sanitizer's diag line.
//
// Precedence (highest first):
//   1. GLM_REASONING_EFFORT env (when set and in the allowed set)
//   2. Client-sent reasoning_effort (when in the allowed set)
//   3. GLM_DEFAULT_EFFORT ("max")
//
// For older GLM models (pre-5.2), any client-sent reasoning_effort is deleted
// so the upstream does not 400 — the param is unsupported there.
function resolveReasoningEffort(parsedBody, bareModel) {
  const model = bareModel || parsedBody.model;

  if (!isGlm52PlusModel(model)) {
    if (Object.prototype.hasOwnProperty.call(parsedBody, "reasoning_effort")) {
      delete parsedBody.reasoning_effort;
      return { source: "(n/a)", changed: true };
    }
    return { source: "(n/a)", changed: false };
  }

  const envEffort = allowedEnvValue("GLM_REASONING_EFFORT", GLM_REASONING_EFFORTS);
  if (envEffort) {
    const prev = parsedBody.reasoning_effort;
    parsedBody.reasoning_effort = envEffort;
    return { source: "env", changed: prev !== envEffort };
  }

  if (Object.prototype.hasOwnProperty.call(parsedBody, "reasoning_effort")) {
    const rawClient = parsedBody.reasoning_effort;
    if (GLM_REASONING_EFFORTS.has(rawClient)) {
      return { source: "client", changed: false };
    }
    diag(
      "GLM_INVALID_EFFORT",
      "model:", parsedBody.model || model,
      "raw:", rawClient,
      "fallback:", GLM_DEFAULT_EFFORT,
      "valid:", "[max|xhigh|high|medium|low|minimal|none]",
    );
    parsedBody.reasoning_effort = GLM_DEFAULT_EFFORT;
    return { source: "default", changed: rawClient !== GLM_DEFAULT_EFFORT };
  }

  parsedBody.reasoning_effort = GLM_DEFAULT_EFFORT;
  return { source: "default", changed: true };
}

export function sanitizeGlmBody(parsedBody, bareModel) {
  if (!parsedBody || !isGlmModel(bareModel || parsedBody.model)) return false;

  let changed = false;
  if (normalizeMaxTokens(parsedBody)) changed = true;
  if (stripUnsupportedParams(parsedBody)) changed = true;
  if (normalizeModel(parsedBody)) changed = true;
  if (normalizeToolChoice(parsedBody)) changed = true;
  if (enableToolStreaming(parsedBody)) changed = true;
  if (injectThinking(parsedBody)) changed = true;

  const { source: effortSource, changed: effortChanged } = resolveReasoningEffort(
    parsedBody,
    bareModel || parsedBody.model,
  );
  if (effortChanged) changed = true;

  if (changed) {
    diag(
      "GLM_BODY_SANITIZED",
      "model:", parsedBody.model || bareModel,
      "thinkingType:", parsedBody.thinking?.type || "(omitted)",
      "clearThinking:", parsedBody.thinking?.clear_thinking ?? "(unset)",
      "reasoningEffort:", parsedBody.reasoning_effort ?? "(unset)",
      "effortSource:", effortSource,
      "toolChoice:", parsedBody.tool_choice || "(unset)",
      "toolStream:", parsedBody.tool_stream ?? "(unset)",
      "maxTokens:", parsedBody.max_tokens ?? "(unset)",
    );
  }

  return changed;
}
