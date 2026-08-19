import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

// TokenRouter (PaleBlueDot) Chat Completions gateway.
// Contract sources (no live TOKENROUTER_API_KEY was available in this workspace
// when Qwen3.8-Max was added; extra-field policy is conservative Chat Completions):
//   - https://www.tokenrouter.com/docs
//   - https://api.tokenrouter.com/v1  (Bearer auth; OpenAI Chat Completions)
//   - pi-tokenrouter 1.2.9 snapshot generated from authenticated GET /v1/models
//     on 2026-08-13 (cdn.jsdelivr.net/npm/pi-tokenrouter@1.2.9)
//     Catalog ID `qwen/qwen3.8-max`: reasoning true, inputs text+image
//   - Moonshot K3: https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart
//   - DeepSeek thinking: https://api-docs.deepseek.com/guides/thinking_mode
//   - Qwen3.8-Max thinking: https://help.aliyun.com/zh/model-studio/deep-thinking
//     and https://qwen.ai/blog?id=qwen3.8
//     Native DashScope extras (`enable_thinking`, `preserve_thinking`) are not
//     injected on this gateway. Thinking is default-on upstream. Client
//     `reasoning_effort` is clamped to xhigh|medium|low; Cursor `thinking` is
//     stripped. Live probe matrix (2026-08-19): skipped — no TOKENROUTER_API_KEY.
//
// Allowlist is exact and case-insensitive for routing. Known catalog IDs
// are canonicalized to the lowercase catalog constant after prefix stripping
// so mixed-case requests share one upstream ID and KV scope. Unknown IDs
// are left as-is after prefix stripping — the proxy does not translate
// catalog names.

export const TOKENROUTER_PREFIX = "tokenrouter/";

export const TOKENROUTER_KIMI_K3 = "moonshotai/kimi-k3";
export const TOKENROUTER_DEEPSEEK_V4_PRO = "deepseek/deepseek-v4-pro-0813";
export const TOKENROUTER_DEEPSEEK_V4_FLASH = "deepseek/deepseek-v4-flash-0731";
export const TOKENROUTER_QWEN_38_MAX = "qwen/qwen3.8-max";

export const TOKENROUTER_SUPPORTED_MODELS = [
  TOKENROUTER_KIMI_K3,
  TOKENROUTER_DEEPSEEK_V4_PRO,
  TOKENROUTER_DEEPSEEK_V4_FLASH,
  TOKENROUTER_QWEN_38_MAX,
];

const TOKENROUTER_SUPPORTED_MODEL_SET = new Set(TOKENROUTER_SUPPORTED_MODELS);

const TOKENROUTER_VISION_BRIDGE_MODELS = new Set([
  TOKENROUTER_DEEPSEEK_V4_PRO,
  TOKENROUTER_DEEPSEEK_V4_FLASH,
]);

const TOKENROUTER_QWEN_EFFORTS = new Set(["xhigh", "medium", "low"]);

function normalizeBareModel(bareModel) {
  return typeof bareModel === "string" ? bareModel.trim().toLowerCase() : "";
}

export function isTokenRouterNativeModel(bareModel) {
  return TOKENROUTER_SUPPORTED_MODEL_SET.has(normalizeBareModel(bareModel));
}

export function isTokenRouterKimiK3(bareModel) {
  return normalizeBareModel(bareModel) === TOKENROUTER_KIMI_K3;
}

export function isTokenRouterDeepSeekV4(bareModel) {
  const model = normalizeBareModel(bareModel);
  return TOKENROUTER_VISION_BRIDGE_MODELS.has(model);
}

export function isTokenRouterQwen38Max(bareModel) {
  return normalizeBareModel(bareModel) === TOKENROUTER_QWEN_38_MAX;
}

export function tokenrouterRequiresVisionBridge(bareModel) {
  return TOKENROUTER_VISION_BRIDGE_MODELS.has(normalizeBareModel(bareModel));
}

export function tokenrouterSupportedModelList() {
  return TOKENROUTER_SUPPORTED_MODELS.join(", ");
}

/**
 * Map a TokenRouter-prefixed or native-qualified ID to the upstream ID.
 * "tokenrouter/moonshotai/kimi-k3" → "moonshotai/kimi-k3"
 * "moonshotai/kimi-k3" → "moonshotai/kimi-k3"
 * "Qwen/Qwen3.8-Max" → "qwen/qwen3.8-max" (known catalog IDs only)
 * Returns "" for empty/invalid input.
 */
export function resolveTokenRouterModel(bare) {
  if (typeof bare !== "string") return "";
  let core = bare.trim();
  if (!core) return "";
  if (core.toLowerCase().startsWith(TOKENROUTER_PREFIX)) {
    core = core.slice(TOKENROUTER_PREFIX.length).trim();
  }
  if (!core) return "";
  const canonical = normalizeBareModel(core);
  return TOKENROUTER_SUPPORTED_MODEL_SET.has(canonical) ? canonical : core;
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
