import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

// TokenRouter (PaleBlueDot) Chat Completions gateway.
// Contract sources (no live TOKENROUTER_API_KEY was available in this workspace
// when Qwen3.8-Max was added; extra-field policy is conservative Chat Completions):
//   - https://www.tokenrouter.com/docs
//   - https://api.tokenrouter.com/v1  (Bearer auth; OpenAI Chat Completions)
//   - pi-tokenrouter 1.3.1 snapshot generated from authenticated GET /v1/models
//     on 2026-08-17 (cdn.jsdelivr.net/npm/pi-tokenrouter@1.3.1)
//     Catalog ID `qwen/qwen3.8-max`: reasoning true, inputs text+image
//     Catalog ID `z-ai/glm-5.2`: reasoning true, inputs text (no image)
//   - Moonshot K3: https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart
//   - DeepSeek thinking: https://api-docs.deepseek.com/guides/thinking_mode
//   - Qwen3.8-Max thinking: https://help.aliyun.com/zh/model-studio/deep-thinking
//     and https://qwen.ai/blog?id=qwen3.8
//     Native DashScope extras (`enable_thinking`, `preserve_thinking`) are not
//     injected on this gateway. Thinking is default-on upstream. Client
//     `reasoning_effort` is clamped to xhigh|medium|low; Cursor `thinking` is
//     stripped. Live probe matrix (2026-08-19): skipped — no TOKENROUTER_API_KEY.
//   - Z.AI GLM-5.2: https://z.ai/llm/glm-5.2 (coding plan; reasoning_effort
//     accepted on 5.2+). TokenRouter is a non-native GLM host, so the GLM-native
//     `thinking` / `tool_stream` fields are NOT injected here (see
//     .cursor/rules/glm-native-detection.mdc). Cursor `thinking` is stripped;
//     valid client `reasoning_effort` is forwarded as-is (max|xhigh|high|
//     medium|low|minimal|none). `z-ai/glm-5.3` uses the same TokenRouter GLM
//     policy and is tried even if the live catalog snapshot has not listed it;
//     an upstream 400 is returned as-is. Live probe matrix: skipped — no
//     TOKENROUTER_API_KEY.
//
// Allowlist is first-version family prefixes, matched case-insensitively
// on a copy. The client catalog ID is forwarded unchanged (including
// `-free` and dated stamps). Only the cursorProxy `tokenrouter/`
// disambiguation prefix is stripped. Unknown stems are rejected with
// 400 tokenrouter_model_unsupported before calling upstream; if
// TokenRouter itself returns 400 (for example glm-5.3 not in catalog),
// that status/body is passed through.

export const TOKENROUTER_PREFIX = "tokenrouter/";

export const TOKENROUTER_KIMI_K3 = "moonshotai/kimi-k3";
export const TOKENROUTER_DEEPSEEK_V4_PRO = "deepseek/deepseek-v4-pro-0813";
export const TOKENROUTER_DEEPSEEK_V4_FLASH = "deepseek/deepseek-v4-flash-0731";
export const TOKENROUTER_QWEN_38_MAX = "qwen/qwen3.8-max";
export const TOKENROUTER_GLM_52 = "z-ai/glm-5.2";
export const TOKENROUTER_GLM_53 = "z-ai/glm-5.3";

export const TOKENROUTER_FAMILY_PREFIXES = [
  "moonshotai/kimi-k3",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.8-max",
  "z-ai/glm-5.2",
  "z-ai/glm-5.3",
];

const TOKENROUTER_DEEPSEEK_V4_PREFIXES = new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
]);

const TOKENROUTER_GLM_PREFIXES = new Set([
  "z-ai/glm-5.2",
  "z-ai/glm-5.3",
]);

const TOKENROUTER_QWEN_EFFORTS = new Set(["xhigh", "medium", "low"]);
const TOKENROUTER_GLM_EFFORTS = new Set([
  "max", "xhigh", "high", "medium", "low", "minimal", "none",
]);

function normalizeBareModel(bareModel) {
  return typeof bareModel === "string" ? bareModel.trim().toLowerCase() : "";
}

function matchesTokenRouterPrefix(norm, prefix) {
  return norm === prefix || norm.startsWith(prefix + "-");
}

function matchTokenRouterFamily(bareModel) {
  const norm = normalizeBareModel(bareModel);
  if (!norm) return null;
  for (const prefix of TOKENROUTER_FAMILY_PREFIXES) {
    if (matchesTokenRouterPrefix(norm, prefix)) return prefix;
  }
  return null;
}

export function isTokenRouterNativeModel(bareModel) {
  return matchTokenRouterFamily(bareModel) !== null;
}

export function isTokenRouterKimiK3(bareModel) {
  return matchesTokenRouterPrefix(normalizeBareModel(bareModel), "moonshotai/kimi-k3");
}

export function isTokenRouterDeepSeekV4(bareModel) {
  const family = matchTokenRouterFamily(bareModel);
  return family != null && TOKENROUTER_DEEPSEEK_V4_PREFIXES.has(family);
}

export function isTokenRouterQwen38Max(bareModel) {
  return matchesTokenRouterPrefix(normalizeBareModel(bareModel), "qwen/qwen3.8-max");
}

export function isTokenRouterGlm52(bareModel) {
  const family = matchTokenRouterFamily(bareModel);
  return family != null && TOKENROUTER_GLM_PREFIXES.has(family);
}

export function tokenrouterRequiresVisionBridge(bareModel) {
  const family = matchTokenRouterFamily(bareModel);
  if (!family) return false;
  return TOKENROUTER_DEEPSEEK_V4_PREFIXES.has(family) || TOKENROUTER_GLM_PREFIXES.has(family);
}

export function tokenrouterSupportedModelList() {
  return TOKENROUTER_FAMILY_PREFIXES.map((prefix) => prefix + "*").join(", ");
}

/**
 * Strip an optional tokenrouter/ disambiguation prefix. The remainder is
 * forwarded unchanged — no lowercase rewrite, no suffix strip.
 * "tokenrouter/qwen/qwen3.8-max-free" → "qwen/qwen3.8-max-free"
 * "Qwen/Qwen3.8-Max" → "Qwen/Qwen3.8-Max"
 * Returns "" for empty/invalid input.
 */
export function resolveTokenRouterModel(bare) {
  if (typeof bare !== "string") return "";
  let core = bare;
  if (core.toLowerCase().startsWith(TOKENROUTER_PREFIX)) {
    core = core.slice(TOKENROUTER_PREFIX.length);
  }
  return core;
}

/**
 * TokenRouter upstreams reject the OpenAI "developer" role (verified by
 * pi-tokenrouter 1.2.9 against every TokenRouter model that serves requests).
 * Convert those turns to "system" before hashing and forwarding.
 */
export function normalizeTokenRouterDeveloperRole(parsedBody) {
  if (!parsedBody || !Array.isArray(parsedBody.messages)) return false;

  let converted = 0;
  const next = parsedBody.messages.map((message) => {
    if (message?.role !== "developer") return message;
    converted++;
    return { ...message, role: "system" };
  });

  if (converted === 0) return false;

  parsedBody.messages = next;
  diag("TOKENROUTER_DEVELOPER_ROLE", "converted:", converted);
  return true;
}

function clampTokenRouterQwenReasoningEffort(raw) {
  if (raw == null || raw === false) return { drop: true };
  if (typeof raw !== "string") return { drop: true };

  const value = raw.trim().toLowerCase();
  if (value === "") return { drop: true };
  if (TOKENROUTER_QWEN_EFFORTS.has(value)) return { effort: value };
  if (value === "max" || value === "high") return { effort: "xhigh" };
  if (value === "minimal") return { effort: "low" };
  return { drop: true };
}

/**
 * Cursor-field sanitizer for TokenRouter Qwen3.8-Max.
 * Strips the Cursor `thinking` object and clamps `reasoning_effort` to
 * Alibaba's xhigh|medium|low. Does not inject DashScope extra fields.
 */
export function sanitizeTokenRouterQwenBody(parsedBody) {
  if (!parsedBody) return false;

  let changed = false;
  const clientThinkingType = parsedBody.thinking?.type;

  if (Object.prototype.hasOwnProperty.call(parsedBody, "thinking")) {
    delete parsedBody.thinking;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(parsedBody, "reasoning_effort")) {
    const next = clampTokenRouterQwenReasoningEffort(parsedBody.reasoning_effort);
    if (next.drop) {
      delete parsedBody.reasoning_effort;
      changed = true;
    } else if (parsedBody.reasoning_effort !== next.effort) {
      parsedBody.reasoning_effort = next.effort;
      changed = true;
    }
  }

  if (changed) {
    diag(
      "TOKENROUTER_QWEN_SANITIZED",
      "model:", parsedBody.model || TOKENROUTER_QWEN_38_MAX,
      "thinkingType:", clientThinkingType || "(omitted)",
      "reasoningEffort:", parsedBody.reasoning_effort ?? "(unset)",
    );
  }

  return changed;
}

function validateTokenRouterGlmReasoningEffort(raw) {
  if (raw == null || raw === false) return { drop: true };
  if (typeof raw !== "string") return { drop: true };

  const value = raw.trim().toLowerCase();
  if (value === "") return { drop: true };
  if (TOKENROUTER_GLM_EFFORTS.has(value)) return { effort: value };
  return { drop: true };
}

/**
 * Cursor-field sanitizer for TokenRouter GLM-5.2 and GLM-5.3.
 * Strips the Cursor `thinking` object, strips any inbound GLM-native
 * `tool_stream` (TokenRouter is a non-native GLM host per
 * .cursor/rules/glm-native-detection.mdc, where `tool_stream` on a non-native
 * host is stripped, not merely uninjected), and forwards a valid client
 * `reasoning_effort` (max|xhigh|high|medium|low|minimal|none) unchanged.
 * Does NOT inject GLM-native `thinking` / `tool_stream` and does not remap
 * `max_completion_tokens` (TokenRouter speaks OpenAI Chat Completions).
 * Invalid effort values are dropped, not defaulted.
 */
export function sanitizeTokenRouterGlmBody(parsedBody) {
  if (!parsedBody) return false;

  let changed = false;
  const clientThinkingType = parsedBody.thinking?.type;

  if (Object.prototype.hasOwnProperty.call(parsedBody, "thinking")) {
    delete parsedBody.thinking;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(parsedBody, "tool_stream")) {
    delete parsedBody.tool_stream;
    changed = true;
  }

  let effortAction = "unset";
  if (Object.prototype.hasOwnProperty.call(parsedBody, "reasoning_effort")) {
    const next = validateTokenRouterGlmReasoningEffort(parsedBody.reasoning_effort);
    if (next.drop) {
      delete parsedBody.reasoning_effort;
      changed = true;
      effortAction = "dropped";
    } else if (parsedBody.reasoning_effort !== next.effort) {
      parsedBody.reasoning_effort = next.effort;
      changed = true;
      effortAction = "normalized";
    } else {
      effortAction = "kept";
    }
  }

  if (changed) {
    diag(
      "TOKENROUTER_GLM_SANITIZED",
      "model:", parsedBody.model || TOKENROUTER_GLM_52,
      "thinkingType:", clientThinkingType || "(omitted)",
      "reasoningEffort:", parsedBody.reasoning_effort ?? "(unset)",
      "effortAction:", effortAction,
    );
  }

  return changed;
}
