import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

const KIMI_THINKING_MIN_TOKENS = 16_000;

const FIXED_VALUE_PARAMS = [
  "temperature",
  "top_p",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "reasoning_effort",
];

function normalizeBareModel(bareModel) {
  return typeof bareModel === "string" ? bareModel.trim().toLowerCase() : "";
}

export function isKimiThinkingModel(bareModel) {
  const m = normalizeBareModel(bareModel);
  if (!m.startsWith("kimi")) return false;
  return m === "kimi-k2.7-code" || m.startsWith("kimi-k2.6") || m.startsWith("kimi-k2.5");
}

function isKimiK27Code(bareModel) {
  return normalizeBareModel(bareModel) === "kimi-k2.7-code";
}

function isKimiK26(bareModel) {
  return normalizeBareModel(bareModel).startsWith("kimi-k2.6");
}

function isKimiK25(bareModel) {
  return normalizeBareModel(bareModel).startsWith("kimi-k2.5");
}

function normalizeToolChoice(parsedBody) {
  const tc = parsedBody.tool_choice;
  if (tc == null || tc === "auto" || tc === "none") return false;

  parsedBody.tool_choice = "auto";
  diag("KIMI_TOOL_CHOICE_FIXED", "from:", JSON.stringify(tc), "to:", "auto");
  return true;
}

function normalizeMaxTokens(parsedBody) {
  let changed = false;

  if (parsedBody.max_tokens == null && parsedBody.max_completion_tokens != null) {
    parsedBody.max_tokens = parsedBody.max_completion_tokens;
    changed = true;
  }

  if (parsedBody.max_completion_tokens != null) {
    delete parsedBody.max_completion_tokens;
    changed = true;
  }

  if (parsedBody.max_tokens != null && parsedBody.max_tokens < KIMI_THINKING_MIN_TOKENS) {
    parsedBody.max_tokens = KIMI_THINKING_MIN_TOKENS;
    changed = true;
  }

  return changed;
}

function applyThinkingRules(parsedBody, bareModel) {
  if (isKimiK27Code(bareModel)) {
    if (!Object.prototype.hasOwnProperty.call(parsedBody, "thinking")) return false;
    delete parsedBody.thinking;
    return true;
  }

  if (isKimiK26(bareModel)) {
    const clientType = parsedBody.thinking?.type;
    if (clientType === "disabled") return false;

    const next = { type: "enabled", keep: "all" };
    const changed = !parsedBody.thinking
      || parsedBody.thinking.type !== next.type
      || parsedBody.thinking.keep !== next.keep;
    parsedBody.thinking = next;
    return changed;
  }

  if (isKimiK25(bareModel)) {
    let changed = false;
    if (!parsedBody.thinking) {
      parsedBody.thinking = { type: "enabled" };
      changed = true;
    }
    if (parsedBody.thinking?.keep != null) {
      delete parsedBody.thinking.keep;
      changed = true;
    }
    return changed;
  }

  return false;
}

export function sanitizeKimiBody(parsedBody, bareModel) {
  if (!parsedBody || !isKimiThinkingModel(bareModel)) return false;

  let changed = false;

  for (const key of FIXED_VALUE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(parsedBody, key)) {
      delete parsedBody[key];
      changed = true;
    }
  }

  if (normalizeToolChoice(parsedBody)) changed = true;
  if (normalizeMaxTokens(parsedBody)) changed = true;
  if (applyThinkingRules(parsedBody, bareModel)) changed = true;

  if (changed) {
    diag(
      "KIMI_BODY_SANITIZED",
      "model:", bareModel,
      "thinkingType:", parsedBody.thinking?.type || "(omitted)",
      "toolChoice:", parsedBody.tool_choice || "(unset)",
      "maxTokens:", parsedBody.max_tokens ?? "(unset)",
    );
  }

  return changed;
}
