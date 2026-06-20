import { allowedEnvValue } from "./auth.js";
import { createLogger } from "./logger.js";

const { diag } = createLogger("proxy");

// Fireworks-hosted GLM 5.2+ supports graded reasoning via reasoning_effort,
// reusing the DeepSeek-V4 mechanism: high/max (with xhigh→max, low/medium→high),
// Fireworks default "high". We default to "max" to match the native GLM provider
// (lib/glm.js) so Fireworks GLM gets the same fullest-reasoning behavior.
//
// Allowed values are scoped to what the Fireworks GLM/DeepSeek-V4 effort mechanism
// accepts. "minimal" is intentionally omitted — unlike native Z.AI GLM, it is not a
// valid Fireworks effort level.
const FIREWORKS_GLM_REASONING_EFFORTS = new Set([
  "max", "xhigh", "high", "medium", "low", "none",
]);
const FIREWORKS_GLM_DEFAULT_EFFORT = "max";

// Detect Fireworks-hosted GLM 5.2+ from the fully-qualified upstream model id
// (e.g. "accounts/fireworks/models/glm-5p2"). Fireworks uses a 'p' minor
// separator, so we normalize glm-5p2 → glm-5.2 before the numeric comparison.
// Numeric comparison keeps any future version (5.10, 6.0, ...) classifying
// correctly and rejects older 4.x/5/5.1 and the glm-5v-turbo vision model.
export function isFireworksGlm52Plus(upstreamModelName) {
  if (typeof upstreamModelName !== "string") return false;
  const bare = upstreamModelName
    .toLowerCase()
    .replace(/^accounts\/[^/]+\/models\//, "");
  // glm-5p2 → glm-5.2, glm-4p7 → glm-4.7 (only the major-p-minor form).
  const norm = bare.replace(/^(glm-\d+)p(\d+)/, "$1.$2");
  const match = /^glm-(\d+)(?:\.(\d+))?(?:[-.]|$)/.exec(norm);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  return major > 5 || (major === 5 && minor >= 2);
}

// Resolve reasoning_effort for Fireworks-hosted GLM 5.2+ requests. Mutates
// parsedBody in place and returns true when it changed the body.
//
// Precedence (highest first):
//   1. FIREWORKS_GLM_REASONING_EFFORT env (when set and in the allowed set)
//   2. Client-sent reasoning_effort (when in the allowed set)
//   3. FIREWORKS_GLM_DEFAULT_EFFORT ("max")
//
// No-op for non-GLM Fireworks models and for GLM older than 5.2, leaving any
// client-sent value untouched (their effort semantics are out of scope).
export function resolveFireworksGlmReasoningEffort(parsedBody, upstreamModelName) {
  if (!parsedBody || !isFireworksGlm52Plus(upstreamModelName)) return false;

  const prev = parsedBody.reasoning_effort;
  let source;

  const envEffort = allowedEnvValue("FIREWORKS_GLM_REASONING_EFFORT", FIREWORKS_GLM_REASONING_EFFORTS);
  if (envEffort) {
    parsedBody.reasoning_effort = envEffort;
    source = "env";
  } else if (Object.prototype.hasOwnProperty.call(parsedBody, "reasoning_effort")) {
    const raw = parsedBody.reasoning_effort;
    if (FIREWORKS_GLM_REASONING_EFFORTS.has(raw)) {
      source = "client";
    } else {
      diag(
        "FIREWORKS_GLM_INVALID_EFFORT",
        "model:", upstreamModelName,
        "raw:", raw,
        "fallback:", FIREWORKS_GLM_DEFAULT_EFFORT,
        "valid:", "[max|xhigh|high|medium|low|none]",
      );
      parsedBody.reasoning_effort = FIREWORKS_GLM_DEFAULT_EFFORT;
      source = "default";
    }
  } else {
    parsedBody.reasoning_effort = FIREWORKS_GLM_DEFAULT_EFFORT;
    source = "default";
  }

  const changed = prev !== parsedBody.reasoning_effort;
  if (changed || source === "client") {
    diag(
      "FIREWORKS_GLM_EFFORT",
      "model:", upstreamModelName,
      "reasoningEffort:", parsedBody.reasoning_effort,
      "effortSource:", source,
    );
  }
  return changed;
}
