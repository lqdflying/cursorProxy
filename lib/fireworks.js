import { allowedEnvValue } from "./auth.js";
import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

// Fireworks-hosted GLM 5.2 supports graded reasoning via reasoning_effort.
// Per the Fireworks Chat Completions API docs for GLM 5.2:
//   - 'high' selects High; 'low'/'medium' collapse to 'high'.
//   - 'max' and 'xhigh' select Max.
//   - 'none' or false disables thinking.
//   - true enables thinking and normalizes to 'medium'.
//   - Omitted defaults to Max.
// We explicitly default to "max" so Fireworks GLM matches the native GLM provider
// (lib/glm.js) and gets the fullest-reasoning behavior.
//
// Allowed string values are scoped to what the Fireworks GLM 5.2 effort mechanism
// accepts. "minimal" is intentionally omitted — unlike native Z.AI GLM, it is not a
// valid Fireworks effort level.
const FIREWORKS_GLM_REASONING_EFFORTS = new Set([
  "max", "xhigh", "high", "medium", "low", "none",
]);
const FIREWORKS_GLM_DEFAULT_EFFORT = "max";

// Exact documented Fireworks GLM 5.2 model IDs (both the Fireworks 'p' separator
// and the dotted form). Scoped narrowly to documented IDs only; do not speculate
// on future glm-5.10 / glm-6 / custom-account contracts without verifying them.
const FIREWORKS_GLM_52_IDS = new Set([
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/glm-5.2",
  "glm-5p2",
  "glm-5.2",
]);

export function isFireworksGlm52Model(upstreamModelName) {
  if (typeof upstreamModelName !== "string") return false;
  return FIREWORKS_GLM_52_IDS.has(upstreamModelName.toLowerCase());
}

// Normalize a client-sent reasoning_effort value for Fireworks GLM 5.2.
// Returns the canonical value to forward, or null when the value is unsupported.
//
// Per Fireworks docs:
//   - false → "none"
//   - true → "medium"
//   - positive integer → preserved as a token budget
//   - string in FIREWORKS_GLM_REASONING_EFFORTS → preserved
function normalizeClientReasoningEffort(raw) {
  if (raw === false) return "none";
  if (raw === true) return "medium";
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && FIREWORKS_GLM_REASONING_EFFORTS.has(raw)) return raw;
  return null;
}

// Resolve reasoning_effort for Fireworks-hosted GLM 5.2 requests. Mutates
// parsedBody in place and returns true when it changed the body.
//
// Precedence (highest first):
//   1. FIREWORKS_GLM_REASONING_EFFORT env (when set and in the allowed string set)
//   2. Client-sent reasoning_effort (false → none, true → medium, positive integer
//      budget preserved, valid string preserved)
//   3. FIREWORKS_GLM_DEFAULT_EFFORT ("max")
//
// No-op for non-GLM-5.2 Fireworks models, leaving any client-sent value untouched.
export function resolveFireworksGlmReasoningEffort(parsedBody, upstreamModelName) {
  if (!parsedBody || !isFireworksGlm52Model(upstreamModelName)) return false;

  const prev = parsedBody.reasoning_effort;
  let source;

  const envEffort = allowedEnvValue("FIREWORKS_GLM_REASONING_EFFORT", FIREWORKS_GLM_REASONING_EFFORTS);
  if (envEffort) {
    parsedBody.reasoning_effort = envEffort;
    source = "env";
  } else if (Object.prototype.hasOwnProperty.call(parsedBody, "reasoning_effort")) {
    const raw = parsedBody.reasoning_effort;
    const normalized = normalizeClientReasoningEffort(raw);
    if (normalized != null) {
      parsedBody.reasoning_effort = normalized;
      source = "client";
    } else {
      diag(
        "FIREWORKS_GLM_INVALID_EFFORT",
        "model:", upstreamModelName,
        "raw:", raw,
        "fallback:", FIREWORKS_GLM_DEFAULT_EFFORT,
        "valid:", "[max|xhigh|high|medium|low|none|true|false|<positive-int>]",
      );
      parsedBody.reasoning_effort = FIREWORKS_GLM_DEFAULT_EFFORT;
      source = "default";
    }
  } else {
    parsedBody.reasoning_effort = FIREWORKS_GLM_DEFAULT_EFFORT;
    source = "default";
  }

  // Always log the resolved effort for Fireworks GLM 5.2 requests (always-on
  // diag) so the value/source is visible even when the body was not mutated
  // (e.g. a valid client value, or an env override matching the existing value).
  diag(
    "FIREWORKS_GLM_EFFORT",
    "model:", upstreamModelName,
    "reasoningEffort:", parsedBody.reasoning_effort,
    "effortSource:", source,
  );
  return prev !== parsedBody.reasoning_effort;
}
