import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

const GLM_ALLOWED_PARAMS = new Set([
  "model",
  "messages",
  "stream",
  "thinking",
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

function normalizeBareModel(bareModel) {
  return typeof bareModel === "string" ? bareModel.trim().toLowerCase() : "";
}

export function isGlmModel(bareModel) {
  return normalizeBareModel(bareModel).startsWith("glm");
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

export function sanitizeGlmBody(parsedBody, bareModel) {
  if (!parsedBody || !isGlmModel(bareModel || parsedBody.model)) return false;

  let changed = false;
  if (normalizeMaxTokens(parsedBody)) changed = true;
  if (stripUnsupportedParams(parsedBody)) changed = true;
  if (normalizeModel(parsedBody)) changed = true;
  if (normalizeToolChoice(parsedBody)) changed = true;
  if (enableToolStreaming(parsedBody)) changed = true;
  if (injectThinking(parsedBody)) changed = true;

  if (changed) {
    diag(
      "GLM_BODY_SANITIZED",
      "model:", parsedBody.model || bareModel,
      "thinkingType:", parsedBody.thinking?.type || "(omitted)",
      "clearThinking:", parsedBody.thinking?.clear_thinking ?? "(unset)",
      "toolChoice:", parsedBody.tool_choice || "(unset)",
      "toolStream:", parsedBody.tool_stream ?? "(unset)",
      "maxTokens:", parsedBody.max_tokens ?? "(unset)",
    );
  }

  return changed;
}
