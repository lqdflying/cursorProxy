import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

// TokenRouter (PaleBlueDot) Chat Completions gateway.
// Contract sources (no live key was available in this workspace):
//   - https://www.tokenrouter.com/docs
//   - https://api.tokenrouter.com/v1  (Bearer auth; OpenAI Chat Completions)
//   - pi-tokenrouter 1.2.9 snapshot generated from authenticated GET /v1/models
//     on 2026-08-13 (cdn.jsdelivr.net/npm/pi-tokenrouter@1.2.9)
//   - Moonshot K3: https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart
//   - DeepSeek thinking: https://api-docs.deepseek.com/guides/thinking_mode
//
// Initial allowlist is exact and case-insensitive for routing. Upstream IDs
// are forwarded byte-for-byte after prefix stripping — the proxy does not
// translate catalog names.

export const TOKENROUTER_PREFIX = "tokenrouter/";

export const TOKENROUTER_KIMI_K3 = "moonshotai/kimi-k3";
export const TOKENROUTER_DEEPSEEK_V4_PRO = "deepseek/deepseek-v4-pro-0813";
export const TOKENROUTER_DEEPSEEK_V4_FLASH = "deepseek/deepseek-v4-flash-0731";

export const TOKENROUTER_SUPPORTED_MODELS = [
  TOKENROUTER_KIMI_K3,
  TOKENROUTER_DEEPSEEK_V4_PRO,
  TOKENROUTER_DEEPSEEK_V4_FLASH,
];

const TOKENROUTER_SUPPORTED_MODEL_SET = new Set(TOKENROUTER_SUPPORTED_MODELS);

const TOKENROUTER_VISION_BRIDGE_MODELS = new Set([
  TOKENROUTER_DEEPSEEK_V4_PRO,
  TOKENROUTER_DEEPSEEK_V4_FLASH,
]);

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
 * Returns "" for empty/invalid input.
 */
export function resolveTokenRouterModel(bare) {
  if (typeof bare !== "string") return "";
  let core = bare.trim();
  if (!core) return "";
  if (core.toLowerCase().startsWith(TOKENROUTER_PREFIX)) {
    core = core.slice(TOKENROUTER_PREFIX.length).trim();
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
