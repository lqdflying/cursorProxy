export const config = { runtime: "edge" };

import { kvDelete, kvGet, kvSet } from "../lib/kv.js";
import {
  mapAnthropicResponseToOpenAI,
  mapAnthropicSSEToOpenAI,
  normalizeAnthropicContentTypes,
  remapAnthropicInput,
  sanitizeAzureAnthropicBody,
} from "../lib/azure-anthropic.js";
import {
  mapResponsesSSEToOpenAI,
  mapResponsesToOpenAI,
  mapResponsesUsageToOpenAI,
  normalizeAzureOpenAIInputContent,
  normalizeOpenAICompatResponsesInputContent,
  normalizeAzureOpenAITools,
  openAICompatResponsesToolFallback,
  sanitizeAzureOpenAIBody,
} from "../lib/azure-openai.js";
import { checkProxyAuth, cleanEnvValue, jsonErrorResponse } from "../lib/auth.js";
import { cacheScopeUserId, conversationHash, normalizedConversationHash, sha256ImageHash } from "../lib/cache.js";
import {
  deriveCompatPromptCacheKey,
  deriveOpenAICompatChatRemotePromptCacheKey,
  deriveOpenAICompatChatRemoteSessionHeader,
  deriveOpenAICompatResponsesHaloPromptCacheKey,
  deriveOpenAICompatSessionAnchor,
  hasInvalidOpenAICompatCacheHitModeEnv,
  hasInvalidOpenAICompatReasoningEffortEnv,
  isOpenAICompatChatCacheFacadeMode,
  isOpenAICompatChatCacheRemoteMode,
  isOpenAICompatHaloCacheMode,
  isOpenAICompatSub2ApiCacheMode,
  openAICompatChatCachedTokens,
  openAICompatCacheHitModeValidValues,
  normalizeOpenAICompatChatCacheUsage,
  openAICompatReasoningEffortEnv,
  shouldAutoInjectPromptCacheKeyForCompat,
} from "../lib/openaicompat-cache.js";
import {
  isModelDiscoveryRequest,
  isOpenAICompatResponses,
  modelDiscoveryResponse,
  normalizeParsedBodyModel,
  openaiCompatWireApi,
  providerFromModel,
  publicModelId,
  resolveAzureAlias,
  resolveCompatibleAlias,
  resolveFireworksModel,
  withPublicResponseModel,
} from "../lib/models.js";
import {
  extractClaudeThinkingBlocks,
  hasReasoningValue,
  injectClaudeThinkingBlocks,
  injectStoredReasoning,
  readReasoning,
  reasoningSize,
  serializeReasoning,
  stripResponseChunk,
  updateStreamReasoning,
} from "../lib/reasoning.js";
import { sanitizeGlmBody } from "../lib/glm.js";
import { resolveFireworksGlmReasoningEffort } from "../lib/fireworks.js";
import { sanitizeKimiBody } from "../lib/kimi.js";
import { convertImagesToText } from "../lib/vision-bridge.js";

const DEBUG = process.env.DEBUG === "true";
const AZURE_OPENAI_RESPONSE_CACHE_VERSION = "v7";
const OPENAICOMPAT_RESPONSE_CACHE_VERSION = "v1";
let proxyAuthWarningLogged = false;
let openAICompatChatReasoningEffortInvalidLogged = false;
const openAICompatPreviousResponseUnsupportedScopes = new Map();

// Soft caps for per-stream string accumulators. These prevent a runaway
// reasoning model from OOMing a single Vercel Edge instance during a long
// stream. The values are stored, not the forwarded SSE — clients still see
// the full upstream output; only the proxy's internal accumulators are bounded.
// Override via env when needed.
function readSizeCap(envName, fallback) {
  const raw = parseInt(process.env[envName] || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return fallback;
}
const ACC_CONTENT_CAP = readSizeCap("ACC_CONTENT_CAP_CHARS", 4_000_000);   // ~4MB chars
const ACC_REASONING_CAP = readSizeCap("ACC_REASONING_CAP_CHARS", 8_000_000); // ~8MB chars
const ACC_REFUSAL_CAP = 64_000;

// Pure helper: count incoming strict: true tools by detected shape.
// Exported for direct unit testing. Returns read-only stats; parsedBody is not mutated.
export function strictToolStats(parsedBody) {
  const empty = {
    total: 0,
    strict: 0,
    functions: 0,
    byFormat: { chatCompletions: 0, anthropicNative: 0, responsesInline: 0, unknown: 0 },
  };
  if (!parsedBody || !Array.isArray(parsedBody.tools) || parsedBody.tools.length === 0) {
    return empty;
  }
  const stats = {
    total: parsedBody.tools.length,
    strict: 0,
    functions: 0,
    byFormat: { chatCompletions: 0, anthropicNative: 0, responsesInline: 0, unknown: 0 },
  };
  for (const tool of parsedBody.tools) {
    const isFunctionType = tool?.type === "function";
    const hasFunctionObject = tool?.function && typeof tool.function === "object";
    const hasInputSchema = tool?.input_schema && typeof tool.input_schema === "object";
    const hasFunctionStrict = tool?.function?.strict === true;
    const hasToolStrict = tool?.strict === true;

    // Count any recognizable function tool: wrapped Chat Completions, inline
    // Responses, or Anthropic native (identified by input_schema).
    if (isFunctionType || hasInputSchema) {
      stats.functions++;
    }

    // OpenAI Chat Completions format: { type: "function", function: { strict: true } }
    if (isFunctionType && hasFunctionStrict) {
      stats.strict++;
      stats.byFormat.chatCompletions++;
      continue;
    }
    // Anthropic native format: { strict: true, input_schema: { ... } }
    if (hasToolStrict && hasInputSchema) {
      stats.strict++;
      stats.byFormat.anthropicNative++;
      continue;
    }
    // Azure OpenAI Responses inline format: { type: "function", strict: true, ... }
    if (isFunctionType && hasToolStrict && !hasFunctionObject) {
      stats.strict++;
      stats.byFormat.responsesInline++;
      continue;
    }
    // Any other strict: true that did not match a known shape.
    if (hasToolStrict || hasFunctionStrict) {
      stats.strict++;
      stats.byFormat.unknown++;
    }
  }
  return stats;
}

// Passive probe: count incoming strict: true tools per provider before any
// sanitization. This is intentionally read-only and allocation-light so it can
// run on every request without side effects.
function probeStrictTools(providerKey, parsedBody) {
  const stats = strictToolStats(parsedBody);
  if (stats.strict > 0) {
    diag("STRICT_TOOLS_PROBE",
      "provider:", providerKey || "infer",
      "total:", stats.total,
      "functions:", stats.functions,
      "strict:", stats.strict,
      "chatCmpl:", stats.byFormat.chatCompletions,
      "anthropic:", stats.byFormat.anthropicNative,
      "responses:", stats.byFormat.responsesInline,
      "unknown:", stats.byFormat.unknown);
  }
}

const PROVIDERS = {
  deepseek: {
    url: process.env.UPSTREAM_DEEPSEEK || "https://api.deepseek.com",
    host: "api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  kimi: {
    url: process.env.UPSTREAM_KIMI || "https://api.moonshot.ai",
    host: "api.moonshot.ai",
    apiKeyEnv: "KIMI_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  minimax: {
    url: process.env.UPSTREAM_MINIMAX || "https://api.minimax.io",
    host: "api.minimax.io",
    apiKeyEnv: "MINIMAX_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  mimo: {
    url: process.env.UPSTREAM_MIMO || "https://api.xiaomimimo.com",
    host: "api.xiaomimimo.com",
    apiKeyEnv: "MIMO_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  glm: {
    url: process.env.UPSTREAM_GLM || "https://open.bigmodel.cn/api/coding/paas/v4",
    host: "open.bigmodel.cn",
    apiKeyEnv: "GLM_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
    buildUrl(_model, pathParam, queryString) {
      const base = (process.env.UPSTREAM_GLM || "https://open.bigmodel.cn/api/coding/paas/v4")
        .replace(/\/+$/, "");
      const path = String(pathParam || "").replace(/^\/+/, "");
      return `${base}/${path}${queryString || ""}`;
    },
  },
  fireworks: {
    url: process.env.UPSTREAM_FIREWORKS || "https://api.fireworks.ai/inference",
    host: "api.fireworks.ai",
    apiKeyEnv: "FIREWORKS_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  openaicompat: {
    url: process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com",
    get host() {
      try { return new URL(process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com").hostname; }
      catch { return "api.openai.com"; }
    },
    apiKeyEnv: "OPENAICOMPAT_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
    buildUrl(_model, pathParam, queryString) {
      // Normalize the base URL: strip trailing slashes and a trailing /v1
      // so both https://host and https://host/v1 produce /v1/<path> (not /v1/v1/...).
      const raw = (process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com").replace(/\/+$/, "");
      const base = raw.replace(/\/v1$/i, "");
      // Responses wire mode: remap chat/completions → responses. Only this
      // path is remapped; /models and other paths pass through unchanged.
      const responsesMode = openaiCompatWireApi() === "responses";
      const remapped = responsesMode && pathParam === "chat/completions" ? "responses" : pathParam;
      return `${base}/v1/${remapped}${queryString || ""}`;
    },
  },
  anthropiccompat: {
    get url() {
      return process.env.UPSTREAM_ANTHROPICCOMPAT || "https://api.anthropic.com";
    },
    get host() {
      try { return new URL(process.env.UPSTREAM_ANTHROPICCOMPAT || "https://api.anthropic.com").hostname; }
      catch { return "api.anthropic.com"; }
    },
    apiKeyEnv: "ANTHROPICCOMPAT_API_KEY",
    get authHeaderName() {
      const mode = (process.env.ANTHROPICCOMPAT_AUTH_MODE || "api-key").trim().toLowerCase();
      return mode === "bearer" ? "authorization" : "x-api-key";
    },
    get authHeaderPrefix() {
      const mode = (process.env.ANTHROPICCOMPAT_AUTH_MODE || "api-key").trim().toLowerCase();
      return mode === "bearer" ? "Bearer " : "";
    },
    get extraHeaders() {
      const mode = (process.env.ANTHROPICCOMPAT_AUTH_MODE || "api-key").trim().toLowerCase();
      return mode === "bearer" ? {} : { "anthropic-version": "2023-06-01" };
    },
    buildUrl(_model, pathParam, queryString) {
      const base = (process.env.UPSTREAM_ANTHROPICCOMPAT || "https://api.anthropic.com")
        .replace(/\/+$/, "");
      const remapped = pathParam === "chat/completions" ? "messages" : pathParam;
      return `${base}/v1/${remapped}${queryString || ""}`;
    },
  },
  azureopenai: {
    apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    authHeaderName: "api-key",
    authHeaderPrefix: "",
    buildUrl(model, pathParam, queryString) {
      // Responses API: model is in request body, not URL path.
      // Path remapped from chat/completions → responses.
      const base = process.env.AZURE_OPENAI_ENDPOINT
        || `https://${process.env.AZURE_FOUNDRY_RESOURCE}.cognitiveservices.azure.com`;
      const version = process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
      const remapped = pathParam === "chat/completions" ? "responses" : pathParam;
      const qs = queryString ? `&${queryString.slice(1)}` : "";
      return `${base}/openai/${remapped}?api-version=${version}${qs}`;
    },
  },
  azureanthropic: {
    apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    authHeaderName: "x-api-key",
    authHeaderPrefix: "",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    buildUrl(model, pathParam, queryString) {
      const base = process.env.AZURE_ANTHROPIC_ENDPOINT
        || `https://${process.env.AZURE_FOUNDRY_RESOURCE}.services.ai.azure.com`;
      // queryString already includes leading "?" — use as-is
      const qs = queryString || "";
      // Remap OpenAI-compatible paths to Anthropic Messages API equivalents.
      // Cursor sends chat/completions — Anthropic expects messages.
      const remapped = pathParam === "chat/completions" ? "messages" : pathParam;
      return `${base}/anthropic/v1/${remapped}${qs}`;
    },
  },
};

function log(...args) {
  if (process.env.DEBUG === "true") console.log("[cursorProxy:proxy]", ...args);
}

function diag(...args) {
  console.log("[cursorProxy:proxy]", ...args);
}

function safeLogToken(value, fallback = "(none)") {
  if (value == null || value === "") return fallback;
  return String(value).replace(/\s+/g, "_").slice(0, 80);
}

function summarizeToolChoiceForLog(value) {
  if (value == null || value === "") return "(none)";
  if (typeof value === "string") return safeLogToken(value);
  if (typeof value !== "object" || Array.isArray(value)) return typeof value;
  const type = value.type ? safeLogToken(value.type) : "object";
  const functionShape = value.function && typeof value.function === "object" ? "function" : "";
  return functionShape ? `${type}:${functionShape}` : type;
}

function summarizeJsonArgKeysForLog(rawArgs) {
  const text = typeof rawArgs === "string" ? rawArgs.trim() : "";
  if (!text) return "(none)";
  try {
    const parsed = JSON.parse(text);
    if (parsed == null) return "null";
    if (Array.isArray(parsed)) return "array";
    if (typeof parsed !== "object") return typeof parsed;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return "(none)";
    const shown = keys.slice(0, 12).map((key) => safeLogToken(key, "(empty)"));
    if (keys.length > shown.length) shown.push(`+${keys.length - shown.length}`);
    return shown.join(",");
  } catch {
    return "(unparseable)";
  }
}

function appendStringLengthShape(out, key, value, label = key) {
  if (typeof value === "string") out.push(`${label}Len:`, value.length);
}

function appendPresenceShape(out, key, value, label = key) {
  out.push(`${label}:`, value == null ? "absent" : "present");
}

function summarizeToolArgShapeForLog(toolName, rawArgs) {
  const text = typeof rawArgs === "string" ? rawArgs.trim() : "";
  if (!text) return ["shape:", "(empty)"];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ["shape:", "(unparseable)"];
  }

  if (parsed == null) return ["shape:", "null"];
  if (Array.isArray(parsed)) return ["shape:", "array", "items:", parsed.length];
  if (typeof parsed !== "object") return ["shape:", typeof parsed];

  const keys = Object.keys(parsed);
  const out = ["shape:", "object", "keyCount:", keys.length];
  const normalizedToolName = String(toolName || "").trim().toLowerCase();

  if (normalizedToolName === "shell") {
    appendStringLengthShape(out, "command", parsed.command);
    appendStringLengthShape(out, "description", parsed.description);
    appendPresenceShape(out, "working_directory", parsed.working_directory, "workingDirectory");

    const notify = parsed.notify_on_output;
    if (notify && typeof notify === "object" && !Array.isArray(notify)) {
      out.push("notify:", "present");
      appendStringLengthShape(out, "pattern", notify.pattern, "notifyPattern");
      appendStringLengthShape(out, "reason", notify.reason, "notifyReason");
      if (typeof notify.debounce_ms === "number") out.push("notifyDebounceMs:", notify.debounce_ms);
    } else {
      out.push("notify:", notify == null ? "absent" : typeof notify);
    }
    return out;
  }

  if (normalizedToolName === "callmcptool") {
    appendStringLengthShape(out, "server", parsed.server);
    appendStringLengthShape(out, "toolName", parsed.toolName);
    const mcpArgs = parsed.arguments;
    if (mcpArgs && typeof mcpArgs === "object" && !Array.isArray(mcpArgs)) {
      out.push("mcpArguments:", "present", "mcpArgKeys:", summarizeJsonArgKeysForLog(JSON.stringify(mcpArgs)));
    } else {
      out.push("mcpArguments:", mcpArgs == null ? "absent" : Array.isArray(mcpArgs) ? "array" : typeof mcpArgs);
    }
  }

  return out;
}

function responsesToolStateForLog(toolState, data) {
  const idx = data?.output_index ?? 0;
  return (data?.call_id && toolState.get(data.call_id))
    || (data?.item_id && toolState.get(`item:${data.item_id}`))
    || toolState.get(`index:${idx}`)
    || null;
}

function isResponsesToolDoneEvent(eventName) {
  return eventName === "response.function_call_arguments.done"
    || eventName === "response.custom_tool_call_input.done"
    || eventName === "response.apply_patch_call.done"
    || eventName === "response.apply_patch_call_input.done";
}

function responsesToolArgsForLog(data, state) {
  if (typeof data?.arguments === "string") return data.arguments;
  if (typeof data?.input === "string") return data.input;
  if (typeof data?.patch === "string") return data.patch;
  return state?.partialJson || "";
}

function isResponsesToolArgDeltaEvent(eventName) {
  return eventName === "response.function_call_arguments.delta"
    || eventName === "response.custom_tool_call_input.delta"
    || eventName === "response.apply_patch_call.delta"
    || eventName === "response.apply_patch_call_input.delta";
}

function isCursorSubagentToolName(name) {
  return String(name || "").trim().toLowerCase() === "subagent";
}

function isCursorShellToolName(name) {
  return String(name || "").trim().toLowerCase() === "shell";
}

const CURSOR_SUBAGENT_CLOUD_ONLY_ARG_KEYS = new Set([
  "cloud_base_branch",
  "environment",
  "file_attachments",
]);

function sanitizeCursorSubagentArgsForLocal(rawArgs) {
  const text = typeof rawArgs === "string" ? rawArgs : "";
  if (!text.trim()) return { argsText: text, removed: [], parseError: false };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { argsText: text, removed: [], parseError: false };
    }
    const removed = [];
    for (const key of CURSOR_SUBAGENT_CLOUD_ONLY_ARG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        delete parsed[key];
        removed.push(key);
      }
    }
    return {
      argsText: removed.length > 0 ? JSON.stringify(parsed) : text,
      removed,
      parseError: false,
    };
  } catch {
    return { argsText: text, removed: [], parseError: true };
  }
}

function sanitizeCursorShellArgsForLocal(rawArgs) {
  const text = typeof rawArgs === "string" ? rawArgs : "";
  if (!text.trim()) return { argsText: text, removed: [], parseError: false };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { argsText: text, removed: [], parseError: false };
    }

    const notify = parsed.notify_on_output;
    if (!notify || typeof notify !== "object" || Array.isArray(notify)) {
      return { argsText: text, removed: [], parseError: false };
    }

    if (typeof notify.pattern === "string" && notify.pattern.trim()) {
      return { argsText: text, removed: [], parseError: false };
    }

    delete parsed.notify_on_output;
    return {
      argsText: JSON.stringify(parsed),
      removed: ["notify_on_output"],
      parseError: false,
    };
  } catch {
    return { argsText: text, removed: [], parseError: true };
  }
}

function mapResponsesToolArgsChunkForProxy(state, argsText) {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: state?.toolIndex ?? 0,
          id: state?.id || "",
          type: "function",
          function: { name: state?.name || "", arguments: argsText },
        }],
      },
    }],
  };
}

function mapMissingResponsesToolArgsForProxy(state, finalArgsText) {
  if (!state || typeof finalArgsText !== "string") return null;
  const priorArgs = state.partialJson || "";
  if (finalArgsText === priorArgs) return null;
  if (!finalArgsText.startsWith(priorArgs)) return null;
  const suffix = finalArgsText.slice(priorArgs.length);
  if (!suffix) return null;
  state.partialJson = finalArgsText;
  return mapResponsesToolArgsChunkForProxy(state, suffix);
}

// Confirm at cold start that the opt-in cache flag was honored.
if (process.env.ANTHROPICCOMPAT_THINKING_CACHE === "true") {
  diag("COMPATIBLE_CACHE", "env:", "ANTHROPICCOMPAT_THINKING_CACHE", "enabled:", true);
}

function isAzureFoundryKimiEndpoint(base) {
  try {
    const url = new URL(base || "");
    const host = url.hostname.toLowerCase();
    return host.endsWith(".services.ai.azure.com") || host.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

const MIMO_MULTIMODAL = new Set(["mimo-v2.5", "mimo-v2-omni"]);
const GLM_MULTIMODAL = new Set(["glm-5v-turbo"]);

function requiresVisionBridge(providerKey, bareModel) {
  if (providerKey === "deepseek") return true;
  if (providerKey === "minimax") {
    const m = (bareModel || "").toLowerCase();
    if (m.startsWith("minimax-m3")) return false; // M3 is natively multimodal
    return true; // M2.x still needs the bridge
  }
  if (providerKey === "mimo") {
    const m = (bareModel || "").toLowerCase();
    return !MIMO_MULTIMODAL.has(m);
  }
  if (providerKey === "glm") {
    const m = (bareModel || "").toLowerCase();
    return !GLM_MULTIMODAL.has(m);
  }
  return false;
}

function decodedPathCandidates(pathParam) {
  const candidates = [pathParam];
  let current = pathParam;
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      candidates.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return candidates;
}

function isUnsafeUpstreamPath(pathParam) {
  if (!pathParam) return false;
  for (const candidate of decodedPathCandidates(pathParam)) {
    if (
      candidate.startsWith("/") ||
      candidate.startsWith("\\") ||
      candidate.includes("\\") ||
      candidate.includes("?") ||
      candidate.includes("#") ||
      candidate.includes("\0") ||
      candidate.split("/").includes("..")
    ) {
      return true;
    }
  }
  return false;
}

// Canonicalized conversation hash for openaicompat. Cursor may send tool_calls
// inside assistant messages in Anthropic format ({type:"tool_use", name, input})
// on some turns and OpenAI format ({type:"function", function:{name, arguments}})
// on others, so normalize to OpenAI format before hashing for stable keys.
// Anthropic tool_use blocks carry call arguments in `input` (the args actually
// invoked), not in schema fields — map `input`→`arguments` so the cache key
// reflects what was actually called, not just the tool name.
async function openaicompatConversationHash(messages, upTo, scope) {
  const normalized = messages.slice(0, upTo).map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc) => {
        if (tc.function) return tc;
        const args = tc.input != null
          ? (typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input))
          : (tc.arguments != null ? String(tc.arguments) : "");
        return {
          type: "function",
          function: { name: tc.name || "", arguments: args },
        };
      }),
    };
  });
  return normalizedConversationHash(normalized, normalized.length, scope, "conv:");
}

function upstreamApiKey(providerKey) {
  const meta = PROVIDERS[providerKey] ?? PROVIDERS.deepseek;
  return process.env[meta.apiKeyEnv] || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function openAICompatUnsupportedScopeTtlMs() {
  const raw = parseInt(process.env.KV_TTL_SECONDS || "", 10);
  const ttlSeconds = Number.isFinite(raw) && raw > 0 ? raw : 7200;
  return ttlSeconds * 1000;
}

function markOpenAICompatPreviousResponseUnsupportedScope(scope) {
  if (!scope) return;
  openAICompatPreviousResponseUnsupportedScopes.set(
    scope,
    Date.now() + openAICompatUnsupportedScopeTtlMs()
  );
}

function hasOpenAICompatPreviousResponseUnsupportedScope(scope) {
  if (!scope) return false;
  const expiresAt = openAICompatPreviousResponseUnsupportedScopes.get(scope);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    openAICompatPreviousResponseUnsupportedScopes.delete(scope);
    return false;
  }
  return true;
}

function openAICompatPreviousResponseFailureKind(status, bodyText) {
  const lower = String(bodyText || "").toLowerCase();
  if (status === 400 && lower.includes("previous_response_id")) {
    if (
      lower.includes("unsupported parameter") ||
      lower.includes("only supported on responses websocket") ||
      lower.includes("not supported")
    ) {
      return "unsupported";
    }
  }
  if (
    (status === 400 || status === 404) &&
    (
      lower.includes("previous_response_not_found") ||
      (lower.includes("previous response") && lower.includes("not found"))
    )
  ) {
    return "not_found";
  }
  if (
    status === 400 &&
    lower.includes("no tool call found") &&
    lower.includes("function call output")
  ) {
    return "tool_output_missing";
  }
  return null;
}

function expandResponsesInputToolCallStart(items, start) {
  if (!Array.isArray(items) || start <= 0 || start >= items.length) return start;
  const needed = new Set();
  for (let i = start; i < items.length; i++) {
    if (items[i]?.type !== "function_call_output") continue;
    const callId = String(items[i].call_id || "").trim();
    if (callId) needed.add(callId);
  }
  if (needed.size === 0) return start;
  let expandedStart = start;
  for (let i = start - 1; i >= 0 && needed.size > 0; i--) {
    if (items[i]?.type !== "function_call") continue;
    const callId = String(items[i].call_id || "").trim();
    if (!needed.has(callId)) continue;
    needed.delete(callId);
    expandedStart = i;
  }
  return expandedStart;
}

function countResponsesFunctionCallOutputs(items) {
  if (!Array.isArray(items)) return 0;
  let count = 0;
  for (const item of items) {
    if (item?.type === "function_call_output") count++;
  }
  return count;
}

async function waitForAzResponseId(key, retries = 2) {
  // Response IDs are written to KV before the proxy responds to Cursor,
  // so the next request usually finds the key immediately. Short retry
  // window covers the rare race where Cursor fires the next turn while
  // the current turn's finally block is still flushing.
  const delays = retries > 0 ? [0, 80, 200] : [0];
  for (let i = 0; i < Math.min(delays.length, retries + 1); i++) {
    if (i > 0) await sleep(delays[i]);
    const stored = await kvGet(key);
    if (stored) return stored;
  }
  return null;
}

export default async function handler(req) {
  const t0 = Date.now();
  let azureReplyKey = null; // KV key for saving response ID (azure or openaicompat)
  let respIdPreviousKvKey = null; // full KV key for stale previous_response_id cleanup
  let respIdCachePrefix = "azresp:"; // KV namespace prefix (set in chaining block)
  let respIdChainScope = null;
  let openAICompatStatelessRetryInput = null;
  let openAICompatChatRemoteSession = null;
  let openAICompatResponsesHaloSession = null;
  const authErr = checkProxyAuth(req);
  if (authErr) return authErr;
  if (!cleanEnvValue("CURSORPROXY_API_KEY") && !proxyAuthWarningLogged) {
    proxyAuthWarningLogged = true;
    diag("AUTH_DISABLED", "CURSORPROXY_API_KEY unset; anonymous clients share cache scope");
  }

  const url = new URL(req.url);
  const pathname = url.pathname;
  const searchParams = new URLSearchParams(url.search);

  let providerKey = searchParams.get("provider");
  const pathParam = searchParams.get("path") || "";

  log("START", req.method, req.url, "pathname:", pathname, "provider(query):", providerKey || "(infer)");
  diag("REQ", req.method, pathname, "provider:", providerKey || "infer");

  if (isModelDiscoveryRequest(req, pathname, pathParam)) {
    const response = modelDiscoveryResponse(req);
    diag("RES", response.status, "path:", pathParam, "provider: models", "ms:", Date.now() - t0);
    return response;
  }

  if (isUnsafeUpstreamPath(pathParam)) {
    diag("INVALID_PATH", "path:", pathParam);
    return jsonErrorResponse(
      400,
      "Invalid upstream path.",
      "invalid_path",
      "invalid_request_error"
    );
  }

  // Parse body early for model-based routing (unified /v1 without provider query)
  let bodyText = "";
  let parsedBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyText = await req.text();
    try {
      parsedBody = JSON.parse(bodyText);
    } catch (err) {
      diag("BODY_PARSE_ERROR", "bodyLength:", bodyText.length, "err:", err?.message);
    }
  }

  const clientModelName = parsedBody?.model;
  if (!providerKey) {
    providerKey = providerFromModel(clientModelName);
  }
  if (!providerKey) {
    providerKey = "deepseek";
  }

  // OpenAI-compatible Responses wire mode (OPENAICOMPAT_WIRE_API=responses).
  // When true, openaicompat routes to upstream /v1/responses and chains
  // via previous_response_id, mirroring the azureopenai provider. Computed
  // once per request and reused by every downstream gate so the env-var name
  // is resolved in exactly one place (lib/models.js).
  //
  // PATH GATE: the wire-mode env var only affects the chat/completions path
  // (the one buildUrl remaps to /v1/responses). All other paths
  // (/embeddings, /models, etc.) must pass through UNCHANGED — they must not
  // have their body whitelisted/sanitized by the Responses sanitizer or have
  // store:false injected. So openaiCompatResponses is true only when BOTH the
  // provider is in Responses mode AND this request targets chat/completions.
  const openaiCompatResponses = isOpenAICompatResponses(providerKey)
    && pathParam === "chat/completions";
  if (openaiCompatResponses && hasInvalidOpenAICompatCacheHitModeEnv()) {
    const validValues = openAICompatCacheHitModeValidValues();
    diag("OPENAICOMPAT_CACHE_HIT_MODE_INVALID",
         "raw:", process.env.OPENAICOMPAT_CACHE_HIT_MODE,
         "valid:", validValues);
    return jsonErrorResponse(
      400,
      `Invalid OPENAICOMPAT_CACHE_HIT_MODE "${process.env.OPENAICOMPAT_CACHE_HIT_MODE}". Valid Responses values: ${validValues}.`,
      "openaicompat_cache_hit_mode_invalid",
      "invalid_request_error"
    );
  }
  const openAICompatSub2ApiCache = openaiCompatResponses && isOpenAICompatSub2ApiCacheMode();
  const openAICompatResponsesHaloCache = openaiCompatResponses && isOpenAICompatHaloCacheMode();
  const openAICompatChatCacheFacade = providerKey === "openaicompat"
    && pathParam === "chat/completions"
    && !openaiCompatResponses
    && isOpenAICompatChatCacheFacadeMode();
  const openAICompatChatCacheRemote = providerKey === "openaicompat"
    && pathParam === "chat/completions"
    && !openaiCompatResponses
    && isOpenAICompatChatCacheRemoteMode();
  const openAICompatChatCacheUsageFacade = openAICompatChatCacheFacade || openAICompatChatCacheRemote;
  const responsesStreamIncludeUsage = (providerKey === "azureopenai" || openaiCompatResponses)
    && parsedBody?.stream_options?.include_usage === true;

  // Probe before any mutation so we see the raw client tool shapes.
  probeStrictTools(providerKey, parsedBody);

  let modelNames = normalizeParsedBodyModel(parsedBody);
  let upstreamModelName = modelNames.bare;
  let responseModelName = modelNames.publicId;
  if (modelNames.changed) {
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_STRIP", "from:", modelNames.input, "to:", upstreamModelName);
  }

  // Azure OpenAI alias resolution. Public model ids like `gpt-general` are
  // routed to a real deployment chosen by the operator via env vars. The
  // alias is invisible to upstream Azure (parsedBody.model is rewritten
  // to the resolved deployment) but is preserved in the response.model
  // field via `azureAliasPublicId` so clients see the model they asked for.
  let azureAliasInfo = null;
  let azureAliasPublicId = "";
  if (providerKey === "azureopenai") {
    const aliasResult = resolveAzureAlias(upstreamModelName);
    if (aliasResult && !aliasResult.configured) {
      diag("AZURE_ALIAS_UNCONFIGURED",
        "alias:", aliasResult.aliasName,
        "targetEnv:", aliasResult.targetEnv);
      return jsonErrorResponse(
        503,
        `Azure OpenAI alias "${aliasResult.aliasName}" is registered but ${aliasResult.targetEnv} is not set. Set ${aliasResult.targetEnv} to the real Azure deployment name.`,
        "azure_alias_unconfigured",
        "api_error"
      );
    }
    if (aliasResult && aliasResult.configured) {
      azureAliasInfo = aliasResult;
      azureAliasPublicId = publicModelId(aliasResult.aliasName);
      parsedBody.model = aliasResult.target;
      upstreamModelName = aliasResult.target;
      responseModelName = azureAliasPublicId;
      bodyText = JSON.stringify(parsedBody);
      diag("AZURE_ALIAS_RESOLVED",
        "alias:", aliasResult.aliasName,
        "target:", aliasResult.target);
    }
  }

  // Fireworks model ID mapping: cursorproxy/fireworks/<model> →
  // accounts/fireworks/models/<model>.  The client-visible response model stays
  // as cursorproxy/fireworks/<model> (no rewind needed — responseModelName
  // already holds the correct public id from normalizeParsedBodyModel).
  // Bare model names without the fireworks/ prefix (e.g. model: "kimi-k2.7-code"
  // sent to /fireworks/v1) are also wrapped so Fireworks receives a valid
  // accounts/fireworks/models/... id.
  let fireworksPublicId = "";
  if (providerKey === "fireworks") {
    let fireworksModel = resolveFireworksModel(upstreamModelName);
    if (!fireworksModel && upstreamModelName) {
      // Preserve already-qualified IDs — any accounts/<account>/models/<model>
      // (including Fireworks-hosted models and custom uploaded models) — to
      // avoid double-prefixing into accounts/fireworks/models/accounts/.../...
      const alreadyQualified = /^accounts\/.+\/models\//i.test(upstreamModelName);
      fireworksModel = alreadyQualified
        ? upstreamModelName
        : "accounts/fireworks/models/" + upstreamModelName;
    }
    if (fireworksModel) {
      fireworksPublicId = responseModelName;
      parsedBody.model = fireworksModel;
      upstreamModelName = fireworksModel;
      bodyText = JSON.stringify(parsedBody);
      diag("FIREWORKS_MODEL_RESOLVED",
        "bare:", modelNames.bare,
        "upstream:", fireworksModel);
    }
  }

  // Compatible-provider alias resolution. Maps "compatible-<name>" model ids
  // to upstream model names (e.g. compatible-gpt-5.5 → gpt-5.5).
  let compatAliasInfo = null;
  let compatAliasPublicId = "";
  if (providerKey === "openaicompat" || providerKey === "anthropiccompat") {
    const aliasResult = resolveCompatibleAlias(upstreamModelName);
    if (aliasResult) {
      if (aliasResult.provider !== providerKey) {
        diag("COMPATIBLE_ALIAS_MISMATCH",
          "alias:", aliasResult.aliasName,
          "aliasProvider:", aliasResult.provider,
          "routeProvider:", providerKey);
        return jsonErrorResponse(
          400,
          `Model "${upstreamModelName}" is a ${aliasResult.provider} alias but was sent to the ${providerKey} route. Use the /${aliasResult.provider}/v1/ route or the unified /v1/ endpoint instead.`,
          "compatible_alias_mismatch",
          "invalid_request_error"
        );
      }
      compatAliasInfo = aliasResult;
      compatAliasPublicId = publicModelId(aliasResult.aliasName);
      parsedBody.model = aliasResult.upstream;
      upstreamModelName = aliasResult.upstream;
      responseModelName = compatAliasPublicId;
      bodyText = JSON.stringify(parsedBody);
      diag("COMPATIBLE_ALIAS_RESOLVED",
        "alias:", aliasResult.aliasName,
        "upstream:", aliasResult.upstream);
    }
  }

  // Default model injection for compatible providers when client omits model.
  if ((providerKey === "openaicompat" || providerKey === "anthropiccompat") && parsedBody && !parsedBody.model) {
    const defaultModel = providerKey === "openaicompat"
      ? (process.env.OPENAICOMPAT_DEFAULT_MODEL || "").trim()
      : (process.env.ANTHROPICCOMPAT_DEFAULT_MODEL || "").trim();
    if (defaultModel) {
      parsedBody.model = defaultModel;
      upstreamModelName = defaultModel;
      bodyText = JSON.stringify(parsedBody);
      diag("COMPATIBLE_DEFAULT_MODEL", "provider:", providerKey, "model:", defaultModel);
    } else {
      diag("COMPATIBLE_NO_MODEL", "provider:", providerKey);
    }
  }

  log("RESOLVED", "model:", responseModelName || parsedBody?.model || "(none)", "provider:", providerKey, "stream:", parsedBody?.stream);

  // Azure Foundry expects the bare deployment name (e.g. "claude-sonnet-4-6"),
  // not client-facing proxy model IDs such as "cursorproxy/claude-sonnet-4-6".
  {
    const remapResult = remapAnthropicInput(providerKey, parsedBody);
    parsedBody = remapResult.parsedBody;
    if (remapResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  if (providerKey === "openaicompat" && pathParam === "chat/completions" && !openaiCompatResponses && parsedBody) {
    const chatReasoningEffort = openAICompatReasoningEffortEnv();
    if (chatReasoningEffort) {
      if (parsedBody.reasoning_effort !== chatReasoningEffort) {
        parsedBody.reasoning_effort = chatReasoningEffort;
        bodyText = JSON.stringify(parsedBody);
      }
      diag("OAI_CHAT_REASONING_EFFORT",
           "provider:", providerKey,
           "effort:", chatReasoningEffort,
           "source:", "openaicompat_env");
    } else if (hasInvalidOpenAICompatReasoningEffortEnv() && !openAICompatChatReasoningEffortInvalidLogged) {
      openAICompatChatReasoningEffortInvalidLogged = true;
      diag("OPENAICOMPAT_REASONING_EFFORT_INVALID",
           "raw:", process.env.OPENAICOMPAT_REASONING_EFFORT,
           "fallback:", "client",
           "valid:", "none|minimal|low|medium|high|xhigh");
    }
  }

  if (openAICompatChatCacheRemote && parsedBody) {
    const remotePromptCache = await deriveOpenAICompatChatRemotePromptCacheKey(
      req,
      parsedBody,
      parsedBody?.model || upstreamModelName || ""
    );
    if (remotePromptCache.key) {
      if (String(parsedBody.prompt_cache_key || "").trim() === "") {
        parsedBody.prompt_cache_key = remotePromptCache.key;
        bodyText = JSON.stringify(parsedBody);
      }
      diag("OAI_CHAT_REMOTE_KEY",
           "provider:", providerKey,
           "source:", remotePromptCache.source,
           "key:", remotePromptCache.key.slice(0, 24) + "...");
      openAICompatChatRemoteSession = await deriveOpenAICompatChatRemoteSessionHeader(req, remotePromptCache);
      if (openAICompatChatRemoteSession.value) {
        diag("OAI_CHAT_REMOTE_SESSION",
             "provider:", providerKey,
             "source:", openAICompatChatRemoteSession.source,
             "hash:", openAICompatChatRemoteSession.hash || "(none)");
      }
    }
  }

  if (openAICompatResponsesHaloCache && parsedBody) {
    const haloPromptCache = await deriveOpenAICompatResponsesHaloPromptCacheKey(
      req,
      parsedBody,
      parsedBody?.model || upstreamModelName || ""
    );
    if (haloPromptCache.key) {
      if (String(parsedBody.prompt_cache_key || "").trim() === "") {
        parsedBody.prompt_cache_key = haloPromptCache.key;
        bodyText = JSON.stringify(parsedBody);
      }
      diag("OAI_RESP_HALO_KEY",
           "provider:", providerKey,
           "source:", haloPromptCache.source,
           "key:", haloPromptCache.key.slice(0, 24) + "...");
      openAICompatResponsesHaloSession = await deriveOpenAICompatChatRemoteSessionHeader(req, haloPromptCache);
      if (openAICompatResponsesHaloSession.value) {
        diag("OAI_RESP_HALO_SESSION",
             "provider:", providerKey,
             "source:", openAICompatResponsesHaloSession.source,
             "hash:", openAICompatResponsesHaloSession.hash || "(none)");
      }
    }
  }

  // Azure OpenAI Responses API and OpenAI-compatible Responses wire mode both
  // use "input" natively. Do not normalize native Responses input items
  // (input_text, output_text, function_call_output, etc.).
  // previous_response_id chaining via KV.
  //
  // Supports two input formats from the client:
  //   1. Legacy Chat Completions `messages` — renamed to `input` with
  //      tool-call normalization (role:"tool" → function_call_output,
  //      assistant.tool_calls → function_call items).
  //   2. Native Responses API `input` — items already in Responses format.
  //
  // When a prior assistant turn exists, try to recover the response ID from KV
  // and use previous_response_id chaining so the upstream reuses server-side
  // context instead of re-reasoning from scratch on every turn. Falls back to
  // stateless full-input-array mode on KV miss.
  //
  // The block runs for azureopenai (always) and openaicompat (only when
  // OPENAICOMPAT_WIRE_API=responses). The `responsesProvider` boolean and the
  // `cachePrefix`/`cacheVersion` variables below parameterize the provider-
  // specific KV namespace and scope so the two providers never collide.
  if (providerKey === "azureopenai" || openaiCompatResponses) {
    // Provider-specific KV namespace prefix and cache version.
    // Azure uses azresp: (distinct from the openaicompat oairesp: namespace)
    // so the two providers' response IDs are isolated even when they share a
    // KV backend. The variable names (azureReplyKey, azureResponseId, etc.)
    // are provider-generic despite the legacy "azure" prefix.
    respIdCachePrefix = openaiCompatResponses ? "oairesp:" : "azresp:";
    const cachePrefix = respIdCachePrefix;
    const cacheVersion = openaiCompatResponses
      ? OPENAICOMPAT_RESPONSE_CACHE_VERSION
      : AZURE_OPENAI_RESPONSE_CACHE_VERSION;

    // Provider-wide guard: store:false (privacy/compliance opt-out) is
    // incompatible with background:true (background responses cannot
    // resume without server-side stored state). Reject before any shape
    // detection so the rule applies uniformly to messages, array input,
    // string input, and missing input. A later sanitizer would silently
    // flip store:true on a background job, defeating the opt-out — that
    // path is also hardened, but rejecting here is the source of truth.
    if (parsedBody?.store === false && parsedBody?.background === true) {
      diag("STORE_BACKGROUND_CONFLICT", "provider:", providerKey, "store:false + background:true is incompatible");
      return jsonErrorResponse(
        400,
        `store:false is incompatible with background:true. Background responses require server-side stored state to resume. Send store:true to allow chaining, or drop background:true for a stateless one-shot.`,
        "store_background_conflict",
        "invalid_request_error"
      );
    }

    const hasMessages = parsedBody?.messages && !parsedBody?.input;
    const hasInput = parsedBody?.input && Array.isArray(parsedBody.input);

    if (hasMessages || hasInput) {
      const azureScopeUser = await cacheScopeUserId(req);
      let openAICompatSessionAnchor = "";
      if (openAICompatSub2ApiCache) {
        const modelForCache = parsedBody?.model || upstreamModelName || "";
        if (!parsedBody.prompt_cache_key && shouldAutoInjectPromptCacheKeyForCompat(modelForCache)) {
          const derivedPromptCacheKey = await deriveCompatPromptCacheKey(parsedBody, modelForCache);
          if (derivedPromptCacheKey) {
            parsedBody.prompt_cache_key = derivedPromptCacheKey;
            bodyText = JSON.stringify(parsedBody);
            diag("OAI_PROMPT_CACHE_KEY_INJECTED",
              "model:", modelForCache,
              "key:", derivedPromptCacheKey.slice(0, 24) + "...");
          }
        }
        openAICompatSessionAnchor = await deriveOpenAICompatSessionAnchor(req, parsedBody, modelForCache);
        if (openAICompatSessionAnchor) {
          diag("OAI_SESSION_ANCHOR",
            "source:", openAICompatSessionAnchor.split("_").slice(0, -1).join("_") || "derived",
            "hash:", openAICompatSessionAnchor.slice(-32));
        }
      }
      // Cache scope: provider-specific identifiers so response IDs from one
      // provider/deployment/resource are never replayed against another.
      //
      // Azure scope embeds:
      //   1. The resolved Azure deployment name — retargeting an alias
      //      (e.g. AZURE_OPENAI_GENERAL_ALIAS_TARGET changing from
      //      gpt-5.5 to gpt-5.5-mini) yields a fresh cache bucket, so
      //      clients won't replay a previous_response_id from the old
      //      deployment and 400 on Azure. Mid-conversation deployment
      //      switches (gpt-general vs gpt-5.5) also stay isolated.
      //   2. A normalized Azure resource/endpoint identifier — moving the
      //      proxy to a different AZURE_OPENAI_ENDPOINT or rotating
      //      AZURE_FOUNDRY_RESOURCE invalidates response ids that only
      //      exist on the prior resource, even when the deployment name
      //      stays the same.
      //
      // OpenAI-compatible scope uses the normalized upstream BASE URL
      // (origin + path with trailing slashes and trailing /v1 stripped)
      // instead of hostname only, so path-based gateways
      // (https://gw/tenantA/v1 vs https://gw/tenantB/v1) don't collide.
      // The resolved model name (after alias resolution) is embedded so
      // switching models mid-conversation yields a fresh bucket.
      let chainScope;
      if (openaiCompatResponses) {
        const upstreamBase = (process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com")
          .replace(/\/+$/, "").replace(/\/v1$/i, "");
        chainScope = openAICompatSub2ApiCache
          ? [
            providerKey,
            cacheVersion,
            "sub2api",
            upstreamBase,
            parsedBody?.model || "(none)",
            openAICompatSessionAnchor || "(none)",
            azureScopeUser,
          ].join(":")
          : openAICompatResponsesHaloCache
            ? [
              providerKey,
              cacheVersion,
              "halo",
              upstreamBase,
              parsedBody?.model || "(none)",
              String(parsedBody?.prompt_cache_key || "").trim() || "(none)",
              azureScopeUser,
            ].join(":")
          : [
            providerKey,
            cacheVersion,
            upstreamBase,
            parsedBody?.model || "(none)",
            azureScopeUser,
          ].join(":");
      } else {
        const azureScopeDeployment = parsedBody?.model || "(none)";
        const azureScopeResource = (
          process.env.AZURE_OPENAI_ENDPOINT
          || process.env.AZURE_FOUNDRY_RESOURCE
          || "(none)"
        ).trim().toLowerCase().replace(/\/+$/, "");
        chainScope = [
          providerKey,
          cacheVersion,
          azureScopeResource,
          azureScopeDeployment,
          azureScopeUser,
        ].join(":");
      }
      respIdChainScope = chainScope;
      const prevRespUnsupported = openaiCompatResponses
        && hasOpenAICompatPreviousResponseUnsupportedScope(chainScope);

      // Build a normalized array for hashing and finding the last assistant
      // turn.  For messages we use the Chat Completions array directly (role
      // field already present).  For native input items in Responses format,
      // the role is either explicit (item.role) or implied by the type
      // (function_call → assistant, function_call_output → tool).  The hash
      // array is used only for conversationHash(), which does
      // JSON.stringify(slice) — same items produce the same key across turns.
      let hashItems;
      let lastAssistantIdx = -1;
      let hashBoundaryIdx = -1;

      if (hasMessages) {
        hashItems = [...parsedBody.messages];
        lastAssistantIdx = hashItems.reduce(
          (last, m, i) => (m.role === "assistant" ? i : last),
          -1,
        );
        hashBoundaryIdx = lastAssistantIdx;
      } else {
        // hasInput — native Responses-format array.
        // Walk backward to find the contiguous assistant block.  Skip
        // trailing non-assistant items first (the next request ends with
        // a new user item), then scan through the assistant block to find
        // both its first and last items.  The block may span multiple
        // items (e.g. message{role:assistant} then function_call items).
        hashItems = [...parsedBody.input];
        let asstBlockEnd = -1;
        let asstBlockStart = hashItems.length;

        // Skip trailing non-assistant items so the scan starts at the
        // last assistant-related item (if any).
        let start = hashItems.length - 1;
        const isAsstItem = (item) =>
          item.role === "assistant" ||
          item.type === "function_call" ||
          item.type === "custom_tool_call" ||
          item.type === "apply_patch_call" ||
          item.type === "reasoning" ||
          item.type === "file_search_call" ||
          item.type === "web_search_call" ||
          item.type === "computer_call" ||
          item.type === "computer_use_preview_call" ||
          item.type === "code_interpreter_call" ||
          item.type === "image_generation_call" ||
          item.type === "local_shell_call" ||
          item.type === "shell_call" ||
          item.type === "mcp_call" ||
          item.type === "mcp_list_tools" ||
          item.type === "mcp_approval_request" ||
          (item.type === "message" && item.role === "assistant");
        while (start >= 0 && !isAsstItem(hashItems[start])) {
          start--;
        }
        if (start >= 0) {
          asstBlockEnd = start;
          asstBlockStart = start + 1;
          // Walk backward through the contiguous assistant block.
          for (let i = start; i >= 0; i--) {
            if (!isAsstItem(hashItems[i])) break;
            asstBlockStart = i;
          }
        }

        // hashBoundary: items BEFORE the assistant block (for response ID hash)
        // lastAssistantIdx: LAST item in the assistant block (for trim)
        hashBoundaryIdx = asstBlockStart;
        lastAssistantIdx = asstBlockEnd;
      }

      // Compute hashes from the original Cursor/request input shape before
      // forwarding-only normalizers mutate parsedBody. Do not move any
      // input/messages/tool/content normalization above this block unless the
      // read and write hash fixtures are updated together.
      // conversationHash(messages, upTo, scope) hashes messages.slice(0, upTo),
      // so upTo=hashItems.length hashes ALL items.
      azureReplyKey = await conversationHash(hashItems, hashItems.length, chainScope);

      // Honour an explicit client opt-out before doing anything KV-related.
      // store:false means the client requires this turn to be stateless
      // upstream (compliance / privacy-sensitive workloads). That implies
      // BOTH directions:
      //   - we must not forward a previous_response_id (which would replay
      //     prior turns the client has just asked us to forget), and
      //   - we must not persist this turn's response id for the next turn.
      // Skip the KV read entirely and clear the write key. The store:false +
      // background:true conflict is rejected as a 400 at the provider-wide
      // guard above, so reaching here with storeOptOut implies background
      // is omitted or false.
      const storeOptOut = parsedBody.store === false;
      if (storeOptOut) {
        azureReplyKey = null;
        diag("STORE_OPT_OUT", "provider:", providerKey, "client sent store:false — chaining disabled (no prev lookup, no KV write)");
      }
      if (prevRespUnsupported) {
        azureReplyKey = null;
        diag("OAI_PREV_RESP_UNSUPPORTED_SKIP", "provider:", providerKey, "mode:", "stateless");
      }

      // Look up a cached response ID from the prior turn.
      // hashBoundaryIdx marks items BEFORE the contiguous assistant block.
      let prevRespId = null;
      if (!storeOptOut && !prevRespUnsupported && hashBoundaryIdx >= 0) {
        const prevRespKey = await conversationHash(hashItems, hashBoundaryIdx, chainScope);
        respIdPreviousKvKey = cachePrefix + prevRespKey;
        const readResult = await waitForAzResponseId(respIdPreviousKvKey);
        if (readResult) {
          prevRespId = readResult;
          diag("PREV_RESP_ID_FOUND", "key:", prevRespKey, "id:", prevRespId);
        } else {
          diag("PREV_RESP_ID_MISS", "key:", prevRespKey);
        }
      }

      // store=true is required for previous_response_id lookups to work, but
      // we only set it for clients that didn't explicitly opt out above. When
      // storeOptOut is true, parsedBody.store stays false and Azure won't
      // persist server-side state for this turn.
      if (!storeOptOut) {
        parsedBody.store = true;
      }

      if (hasMessages) {
        // Chat Completions → Responses conversion with tool-call normalization.
        // Chat Completions clients use role:"tool" for tool results and
        // assistant.tool_calls for function calls.  The Responses API expects
        // function_call_output and function_call items respectively.
        const normalizeAzureInput = (item) => {
          // Tool result
          if (item.role === "tool") {
            return [{
              type: "function_call_output",
              call_id: item.tool_call_id || "",
              output: typeof item.content === "string"
                ? item.content
                : JSON.stringify(item.content || ""),
            }];
          }
          // Assistant with tool_calls: emit text content (if any), then each
          // tool call as a function_call item that the Responses API can thread.
          if (item.role === "assistant" && item.tool_calls?.length) {
            const items = [];
            if (item.content) {
              items.push({ type: "message", role: "assistant", content: item.content });
            }
            for (const tc of item.tool_calls) {
              items.push({
                type: "function_call",
                call_id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "{}",
              });
            }
            return items;
          }
          return [item];
        };

        const fullInput = parsedBody.messages.reduce((acc, item) => {
          acc.push(...normalizeAzureInput(item));
          return acc;
        }, []);

        if (prevRespId) {
          // If trimming would produce an empty input, force stateless mode.
          // Azure rejects previous_response_id with no new items.
          const nextMessages = parsedBody.messages.slice(lastAssistantIdx + 1);
          if (nextMessages.length === 0) {
            prevRespId = null;
            openAICompatStatelessRetryInput = null;
            log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
                 "lastAssistantIdx:", lastAssistantIdx,
                 "totalItems:", parsedBody.messages.length);
          } else {
            if (openaiCompatResponses) {
              openAICompatStatelessRetryInput = cloneJson(fullInput);
            }
            // Only send input items that appeared AFTER the last assistant.
            // Azure replays the full prior conversation server-side.
            const trimmedInput = nextMessages.reduce((acc, item) => {
              acc.push(...normalizeAzureInput(item));
              return acc;
            }, []);
            const toolOutputCount = countResponsesFunctionCallOutputs(trimmedInput);
            if (openAICompatResponsesHaloCache && toolOutputCount > 0) {
              prevRespId = null;
              parsedBody.input = fullInput;
              diag("OAI_RESP_HALO_TOOL_OUTPUT_STATELESS",
                   "provider:", providerKey,
                   "inputItems:", fullInput.length,
                   "toolOutputs:", toolOutputCount);
            } else {
              parsedBody.input = trimmedInput;
              parsedBody.previous_response_id = prevRespId;
            }
          }
        }
        if (!prevRespId && !parsedBody.input) {
          // Stateless fallback — full input array (but response is still stored
          // so the NEXT turn can chain from it).
          parsedBody.input = fullInput;
        }
        delete parsedBody.messages;
        bodyText = JSON.stringify(parsedBody);
        diag("MESSAGES_TO_INPUT", "provider:", providerKey,
             "inputItems:", parsedBody.input.length,
             "prevResp:", prevRespId ? prevRespId.slice(0, 20) + "..." : "(none)");
      } else {
        // Native input — items already in Responses API format, no conversion
        // needed.  On KV hit: trim to items after last assistant and chain.
        // On KV miss: leave the full input as-is for stateless mode.

        // Lightweight detection probe: scan for Chat-Completions-shaped tool
        // entries that the current path does NOT normalize.  If these appear
        // in production, a full normalization pass (shared helper) is warranted.
        // Category counts tell us which specific shapes need handling.
        let nRoleTool = 0;
        let nAssistantToolCalls = 0;
        for (const item of parsedBody.input) {
          if (item.role === "tool") { nRoleTool++; continue; }
          if (item.role === "assistant" && item.tool_calls?.length) { nAssistantToolCalls++; }
        }
        if (nRoleTool > 0 || nAssistantToolCalls > 0) {
          diag("INPUT_HAS_LEGACY_TOOLS", "provider:", providerKey,
               "totalItems:", parsedBody.input.length,
               "roleTool:", nRoleTool,
               "assistantToolCalls:", nAssistantToolCalls);
        }

        if (prevRespId) {
          // If trimming would produce an empty input, force stateless mode.
          // Azure rejects previous_response_id with no new items.
          const trimStart = openAICompatSub2ApiCache
            ? expandResponsesInputToolCallStart(parsedBody.input, lastAssistantIdx + 1)
            : lastAssistantIdx + 1;
          const trimmedInput = parsedBody.input.slice(trimStart);
          const toolOutputCount = countResponsesFunctionCallOutputs(trimmedInput);
          if (trimmedInput.length === 0) {
            prevRespId = null;
            openAICompatStatelessRetryInput = null;
            log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
                 "lastAssistantIdx:", lastAssistantIdx,
                 "totalItems:", parsedBody.input.length);
          } else {
            if (openaiCompatResponses) {
              openAICompatStatelessRetryInput = cloneJson(parsedBody.input);
            }
            if (openAICompatResponsesHaloCache && toolOutputCount > 0) {
              prevRespId = null;
              diag("OAI_RESP_HALO_TOOL_OUTPUT_STATELESS",
                   "provider:", providerKey,
                   "inputItems:", parsedBody.input.length,
                   "toolOutputs:", toolOutputCount);
            } else {
              parsedBody.input = trimmedInput;
              parsedBody.previous_response_id = prevRespId;
            }
          }
        }
        bodyText = JSON.stringify(parsedBody);
        diag("INPUT_CHAIN", "provider:", providerKey,
             "inputItems:", parsedBody.input.length,
             "trimmed:", prevRespId ? "yes" : "no (stateless)",
             "prevResp:", prevRespId ? prevRespId.slice(0, 20) + "..." : "(none)");
      }
    }
  }

  // Responses-target body normalizers run only where each provider needs them.
  // Azure requires strict message content parts (input_text/output_text), but
  // some OpenAI-compatible Responses gateways accept the official string
  // EasyInputMessage shape and fail on Azure-style input_text blocks.
  //
  // Tool normalization and the sanitizer still run for openaicompat ONLY on
  // the actual Responses target path (chat/completions → /v1/responses).
  // Gating openaicompat on `openaiCompatResponses` (path-aware) ensures
  // /embeddings, /models, and other paths pass through unmutated — without it
  // the Responses whitelist would strip encoding_format/dimensions and inject
  // store:false into non-Responses endpoints.
  {
    const runInputNorm = providerKey === "azureopenai";
    const inputResult = runInputNorm
      ? normalizeAzureOpenAIInputContent(providerKey, parsedBody)
      : { parsedBody, changed: false };
    parsedBody = inputResult.parsedBody;
    if (inputResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const inputResult = openaiCompatResponses
      ? normalizeOpenAICompatResponsesInputContent(providerKey, parsedBody)
      : { parsedBody, changed: false };
    parsedBody = inputResult.parsedBody;
    if (inputResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const contentTypeResult = normalizeAnthropicContentTypes(providerKey, parsedBody);
    parsedBody = contentTypeResult.parsedBody;
    if (contentTypeResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const runToolsNorm = providerKey === "azureopenai" || openaiCompatResponses;
    const toolsResult = runToolsNorm
      ? normalizeAzureOpenAITools(providerKey, parsedBody)
      : { parsedBody, changed: false };
    parsedBody = toolsResult.parsedBody;
    if (toolsResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  // Normalize tools for openaicompat Chat Completions mode: any tool that lacks
  // the {type:"function", function:{...}} wrapper must be wrapped, since the
  // OpenAI Chat Completions API requires it. This catches both Anthropic-flat
  // ({name, description, input_schema}) and inline OpenAI/Responses
  // ({type:"function", name, parameters}) shapes — both are missing the
  // required `function` object.
  //
  // In Responses wire mode (OPENAICOMPAT_WIRE_API=responses), normalizeAzureOpenAITools
  // already handles the conversion to Responses inline format above, so this
  // Chat-Completions wrapper is skipped to avoid producing the wrong shape.
  if (providerKey === "openaicompat" && !openaiCompatResponses && Array.isArray(parsedBody?.tools)) {
    let toolsFixed = false;
    for (let i = 0; i < parsedBody.tools.length; i++) {
      const t = parsedBody.tools[i];

      // apply_patch is a Responses API built-in tool, not a Chat Completions
      // function tool. Cursor sends it when it thinks the model is
      // apply-patch-capable, but a Chat Completions upstream has no reliable
      // concept of a function named `apply_patch` and will ignore it (returning
      // text instead). Drop it in Chat mode so the model falls back to Cursor's
      // standard editing tools (edit_file, search_replace, write).
      //
      // Cursor may emit apply_patch in several shapes: native Responses
      // {type:"apply_patch"}, custom {type:"custom", name:"apply_patch"}, or
      // already wrapped as {type:"function", function:{name:"apply_patch"}}.
      // This check runs before the wrapper condition so all shapes are caught.
      const applyPatchShape =
        t.name === "apply_patch" ? "name"
        : t.type === "apply_patch" ? "type"
        : t.function?.name === "apply_patch" ? "function_name"
        : null;
      if (applyPatchShape) {
        parsedBody.tools.splice(i, 1);
        i--;
        toolsFixed = true;
        diag("OPENAICOMPAT_APPLY_PATCH_DROPPED", "provider:", providerKey, "shape:", applyPatchShape);
        continue;
      }

      if (t.name && !t.function) {
        // Native Responses tools may carry a `format` field that the model needs
        // to produce valid output. Chat Completions does not support `format`
        // directly, so mirror it into the description. Also ensure a valid
        // `parameters` schema is always present, because some Chat Completions
        // gateways reject or ignore function tools without one.
        const parameters = t.input_schema != null
          ? t.input_schema
          : t.parameters != null
            ? t.parameters
            : { type: "object", properties: {}, additionalProperties: false };
        const descriptionParts = [
          t.description != null ? String(t.description) : "",
          t.format ? `format: ${JSON.stringify(t.format)}` : "",
        ].filter(Boolean);
        const description = descriptionParts.length > 0 ? descriptionParts.join("; ") : undefined;
        parsedBody.tools[i] = {
          type: "function",
          function: {
            name: t.name,
            ...(description != null ? { description } : {}),
            parameters,
            ...(t.strict === true ? { strict: true } : {}),
          },
        };
        toolsFixed = true;
      }
    }
    if (toolsFixed) {
      bodyText = JSON.stringify(parsedBody);
      diag("OPENAICOMPAT_TOOLS_FIXED", "provider:", providerKey, "count:", parsedBody.tools.length);
    }
  }

  if (openAICompatChatCacheUsageFacade && parsedBody?.stream === true) {
    if (!parsedBody.stream_options || typeof parsedBody.stream_options !== "object" || Array.isArray(parsedBody.stream_options)) {
      parsedBody.stream_options = {};
    }
    if (parsedBody.stream_options.include_usage !== true) {
      parsedBody.stream_options.include_usage = true;
      bodyText = JSON.stringify(parsedBody);
      diag("OAI_CHAT_CACHE_INCLUDE_USAGE_FORCED", "provider:", providerKey, "model:", safeLogToken(upstreamModelName || parsedBody?.model || ""));
    }
  }

  let azureModelName = upstreamModelName;

  {
    const runSanitize = providerKey === "azureopenai" || openaiCompatResponses;
    const openAiSanitized = runSanitize
      ? sanitizeAzureOpenAIBody(providerKey, parsedBody, azureModelName, azureAliasInfo)
      : { parsedBody, sanitized: false };
    parsedBody = openAiSanitized.parsedBody;
    if (openAiSanitized.sanitized) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  {
    const anthropicSanitized = sanitizeAzureAnthropicBody(providerKey, parsedBody);
    parsedBody = anthropicSanitized.parsedBody;
    if (anthropicSanitized.sanitized) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerKey)) {
    diag("UNKNOWN_PROVIDER", "model:", parsedBody?.model, "provider:", providerKey);
    return jsonErrorResponse(
      400,
      `Unknown provider "${providerKey}". Use deepseek, kimi, minimax, mimo, glm, fireworks, azureopenai, azureanthropic, openaicompat, or anthropiccompat (or set model to a matching name, e.g. cursorproxy/claude-sonnet-4-6, cursorproxy/compatible-gpt-5.5, or cursorproxy/fireworks/kimi-k2p7-code).`,
      "unknown_provider",
      "invalid_request_error"
    );
  }

  const provider = PROVIDERS[providerKey];
  const providerSecret = upstreamApiKey(providerKey);
  if (!providerSecret) {
    return jsonErrorResponse(
      503,
      `Missing environment variable ${provider.apiKeyEnv} for provider "${providerKey}".`,
      "provider_key_missing",
      "api_error"
    );
  }

  // Inject a default model when missing from the request body.
  // Azure OpenAI and Fireworks are excluded: Azure resolves deployment
  // names server-side; Fireworks hosts 200+ models with no single default.
  if (parsedBody && !parsedBody.model && providerKey !== "azureopenai" && providerKey !== "fireworks") {
    const defaults = { deepseek: "deepseek-chat", kimi: "kimi-k2.7-code", minimax: "MiniMax-M3", mimo: "mimo-v2.5-pro", glm: "glm-5.2", azureanthropic: "claude-sonnet-4-6" };
    parsedBody.model = defaults[providerKey] || "deepseek-chat";
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_INJECTED", "model:", parsedBody.model);
  }

  // Normalize the model name after any injection/stripping, then capture
  // the bare deployment name that Azure Foundry expects in URL paths.
  modelNames = normalizeParsedBodyModel(parsedBody);
  upstreamModelName = modelNames.bare;
  responseModelName = modelNames.publicId;
  if (modelNames.changed) {
    bodyText = JSON.stringify(parsedBody);
    log("MODEL_STRIP", "from:", modelNames.input, "to:", upstreamModelName);
  }
  // Preserve the alias-facing public id. The normalize call above derives
  // responseModelName from the resolved deployment name (e.g. gpt-5.5-mini),
  // which would leak the underlying deployment back to clients.
  if (azureAliasPublicId) {
    responseModelName = azureAliasPublicId;
  }
  // Same for Fireworks: the second normalize overwrites responseModelName
  // with cursorproxy/accounts/fireworks/models/..., restore the original.
  if (fireworksPublicId) {
    responseModelName = fireworksPublicId;
  }
  // Same for compatible-provider aliases: restore the alias public id.
  if (compatAliasPublicId) {
    responseModelName = compatAliasPublicId;
  }
  // Set azureModelName unconditionally after model normalization.
  // Previously this was a lazy-init that could read a stale value.
  if (providerKey === "azureopenai" || providerKey === "azureanthropic") {
    azureModelName = upstreamModelName;
  }

  // Clean up Vercel rewrite query pollution
  searchParams.delete("path");
  searchParams.delete("provider");

  const queryString = searchParams.toString()
    ? "?" + searchParams.toString()
    : "";
  const upstreamUrl = provider.buildUrl
    ? provider.buildUrl(azureModelName, pathParam, queryString)
    : provider.url + "/v1/" + pathParam + queryString;
  log("UPSTREAM", upstreamUrl, "provider:", providerKey);

  if (providerKey === "minimax" && parsedBody) {
    parsedBody.reasoning_split = true;
    // M3 supports toggleable thinking mode; inject adaptive default when omitted
    const bareModel = (parsedBody.model || "").toLowerCase();
    if (bareModel.startsWith("minimax-m3") && !parsedBody.thinking) {
      parsedBody.thinking = { type: "adaptive" };
    }
    bodyText = JSON.stringify(parsedBody);
  }

  // Always inject DeepSeek thinking mode params (proxy controls this; default: high)
  if (providerKey === "deepseek" && parsedBody) {
    parsedBody.thinking = { type: "enabled" };
    const rawEnv = process.env.DEEPSEEK_REASONING_EFFORT || "";
    const effortEnv = rawEnv.trim().replace(/^["']|["']$/g, "");
    // DeepSeek currently accepts "high" and "max". Anything else (typos,
    // future levels) silently falls back to the safe default — but we log it
    // once so operators don't think a misspelled value is taking effect.
    const validEfforts = new Set(["high", "max"]);
    let effort;
    if (effortEnv === "") {
      effort = "high";
    } else if (validEfforts.has(effortEnv)) {
      effort = effortEnv;
    } else {
      effort = "high";
      diag("THINKING_INVALID_EFFORT", "provider: deepseek", "raw_env:", rawEnv, "fallback:", effort, "valid:", "high|max");
    }
    parsedBody.reasoning_effort = effort;
    bodyText = JSON.stringify(parsedBody);
    diag("THINKING", "provider: deepseek", "reasoning_effort:", effort, "raw_env:", rawEnv || "(unset)");
  }

  if (providerKey === "mimo" && parsedBody) {
    parsedBody.thinking = { type: "enabled" };
    bodyText = JSON.stringify(parsedBody);
    diag("THINKING", "provider: mimo", "type: enabled");
  }

  if (providerKey === "kimi" && parsedBody) {
    if (sanitizeKimiBody(parsedBody, upstreamModelName, providerKey)) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  if (providerKey === "glm" && parsedBody) {
    if (sanitizeGlmBody(parsedBody, upstreamModelName)) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  // Fireworks-hosted GLM 5.2 supports graded reasoning via reasoning_effort.
  // Resolve it here — before the enableReasoning gate below — so an injected
  // default (max) or a client "none" is honored by that gate's effort checks.
  if (providerKey === "fireworks" && parsedBody) {
    if (resolveFireworksGlmReasoningEffort(parsedBody, upstreamModelName)) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  const originalMessages = parsedBody?.messages ? structuredClone(parsedBody.messages) : null;

  const scopeUser = await cacheScopeUserId(req);
  // For Fireworks the scope must include the upstream model name so reasoning
  // caches are isolated per model.  Without this, a Qwen reasoning trace could
  // be re-injected into a DeepSeek request (same provider + user scope).
  const scope = providerKey === "fireworks"
    ? providerKey + ":" + upstreamModelName + ":" + scopeUser
    : providerKey + ":" + scopeUser;
  // openaicompat uses Cursor-shaped Chat Completions requests that may be
  // normalized differently between turns (string vs array content, tool call
  // shape, etc.). Use a canonicalized hash so cache keys stay stable across
  // turns. Tool calls inside messages are normalized to OpenAI Chat Completions
  // format before hashing so Anthropic-format tool_calls don't produce empty
  // identities.
  // When the openaicompat opt-in cache is OFF, skip key derivation entirely so
  // neither the inject side nor the store side touches KV — matches how
  // ANTHROPICCOMPAT_THINKING_CACHE gates both sides, and avoids orphaned KV
  // writes for a provider whose inject path is gated off.
  const reasoningCacheDisabled = providerKey === "openaicompat"
    && process.env.OPENAICOMPAT_REASONING_CACHE !== "true";
  const replyReasoningKey = (originalMessages && !reasoningCacheDisabled)
    ? (providerKey === "openaicompat"
      ? await openaicompatConversationHash(originalMessages, originalMessages.length, scope)
      : await conversationHash(originalMessages, originalMessages.length, scope))
    : null;

  let injectedCount = 0;
  // Fireworks hosts 200+ models; only a subset (DeepSeek, Kimi, GLM, MiniMax,
  // Qwen, GPT-OSS families) support reasoning_content.  Skip reasoning injection
  // for ordinary models (Llama, Gemma, Nemotron, etc.) to avoid injecting
  // synthetic placeholders that those models would reject or misinterpret.
  const enableReasoning = providerKey !== "fireworks" ||
    ((/^(?:accounts\/[^/]+\/models\/)?(deepseek|kimi|glm|minimax|qwen|gpt-oss)/i.test(upstreamModelName) ||
      // When the client explicitly opts into preserved or interleaved
      // reasoning, bypass the family-prefix check — custom-named reasoning
      // models should still receive cached reasoning.  (User-ending
      // interleaved requests are already skipped by the isInterleaved gate
      // below; tool-ending interleaved requests need injection for turns
      // after the last user message as Fireworks preserves reasoning
      // through tool calls.)
      parsedBody?.reasoning_history === "preserved" ||
      parsedBody?.reasoning_history === "interleaved" ||
      (parsedBody?.thinking?.keep === "all" && parsedBody?.thinking?.type === "enabled")) &&
      // Skip when the client has explicitly disabled reasoning.
      // Cache hits would inject reasoning despite disabling; misses add ~800 ms
      // of KV retry latency for a feature the client doesn't want.
      parsedBody?.reasoning_history !== "disabled" &&
      parsedBody?.reasoning_effort !== "none" &&
      parsedBody?.reasoning_effort !== false &&
      parsedBody?.thinking?.type !== "disabled" &&
      !/-(?:no-thinking|non-thinking)$/i.test(upstreamModelName));

  // Interleaved mode: Fireworks strips reasoning through the last user message
  // but preserves it through tool calls.  Explicit "interleaved" or models that
  // default to it (Kimi K2p0–K2p6, GLM 4.x, MiniMax M2, DeepSeek V4) skip
  // injection on user-ending requests.  Tool-ending requests still receive it.
  //
  // thinking.keep: "all" with thinking.type: "enabled" is equivalent to
  // reasoning_history: "preserved" per Fireworks docs — it overrides any model
  // default interleaved and enables full reasoning restoration.
  const isInterleaved = parsedBody?.reasoning_history === "interleaved" ||
    (parsedBody?.reasoning_history == null &&
      !(parsedBody?.thinking?.keep === "all" && parsedBody?.thinking?.type === "enabled") &&
      /kimi-k2[.p][0-6](?:[^a-z0-9]|$)|glm-[0-4][.p]|minimax-m2|deepseek-v4/i.test(upstreamModelName));
  const userEndingInterleaved = isInterleaved &&
    originalMessages?.length > 0 &&
    originalMessages[originalMessages.length - 1]?.role === "user";

  // When interleaved and tool-ending, only process assistant messages after the
  // last user message — turns before it would be stripped by upstream anyway,
  // and fetching them from KV adds unnecessary latency (up to ~800 ms on miss).
  let minAssistantIndex = 0;
  if (isInterleaved && !userEndingInterleaved && originalMessages) {
    for (let i = originalMessages.length - 1; i >= 0; i--) {
      if (originalMessages[i]?.role === "user") {
        minAssistantIndex = i + 1;
        break;
      }
    }
  }

  if (originalMessages && enableReasoning && !userEndingInterleaved) {
    const injected = await injectStoredReasoning({
      providerKey,
      parsedBody,
      originalMessages,
      scope,
      conversationHash: providerKey === "openaicompat"
        ? openaicompatConversationHash
        : conversationHash,
      minAssistantIndex,
    });
    parsedBody = injected.parsedBody;
    injectedCount = injected.injectedCount;
    if (
      providerKey === "glm" &&
      injected.missedCount > 0 &&
      parsedBody?.thinking?.type !== "disabled" &&
      parsedBody?.thinking?.clear_thinking !== true
    ) {
      parsedBody.thinking = { ...parsedBody.thinking, clear_thinking: true };
      diag("GLM_THINKING_CLEARED", "misses:", injected.missedCount, "reason:", "missing_prior_reasoning");
    }
    bodyText = JSON.stringify(parsedBody);
  }
  log("INJECTED", injectedCount, "/", originalMessages?.filter((m) => m.role === "assistant").length || 0);

  // --- Claude thinking block injection (azureanthropic only) ---
  // Inject cached thinking blocks into prior assistant messages so Claude
  // doesn't re-reason from scratch on every turn when thinking.type === "adaptive".
  // The existing reasoning bridge (DeepSeek/Kimi/MiniMax/MiMo/GLM) uses reasoning_content
  // as a sibling field — Claude uses multi-block content arrays, hence separate logic.
  if ((providerKey === "azureanthropic" ||
    (providerKey === "anthropiccompat" && process.env.ANTHROPICCOMPAT_THINKING_CACHE === "true")) &&
    parsedBody?.messages && parsedBody?.thinking?.type && parsedBody?.thinking?.type !== "disabled") {
    const claudeInjected = await injectClaudeThinkingBlocks(parsedBody, originalMessages, scope, conversationHash, normalizedConversationHash);
    if (claudeInjected > 0) {
      bodyText = JSON.stringify(parsedBody);
      diag("CLAUDE_THINKING_INJECTED", "count:", claudeInjected);
    }
  }

  // Convert images to text for providers that don't support vision inputs
  // DeepSeek and MiniMax M2.x chat endpoints do not accept inline image_url content.
  // MiniMax M3 is natively multimodal and accepts image_url/video_url directly.
  // MiMo Pro/Flash/TTS variants are text-only; mimo-v2.5 and mimo-v2-omni accept
  // image_url natively. GLM-5.2 is text-only in Z.AI Coding Plan examples; visual
  // GLM models are allowlisted above. The vision API (MiniMax VL-01 by default)
  // describes images and injects text before forwarding when requiresVisionBridge()
  // is true.
  if (requiresVisionBridge(providerKey, upstreamModelName) && parsedBody?.messages) {
    const visionT0 = Date.now();
    const {
      messages: convertedMessages,
      convertedCount,
      errors,
    } = await convertImagesToText(parsedBody.messages, sha256ImageHash);
    const visionMs = Date.now() - visionT0;

    // Apply rewrites whenever ANY image_url part was processed (success OR
    // failure). The previous gate (`convertedCount > 0`) silently dropped the
    // failure-placeholder rewrites and forwarded the original image_url
    // blocks upstream, where DeepSeek/MiniMax accept the request but ignore
    // the images — producing nonsense answers.
    if (convertedCount + errors > 0) {
      parsedBody.messages = convertedMessages;
      bodyText = JSON.stringify(parsedBody);
      diag(
        "CONVERTED_IMAGES",
        "ok:", convertedCount,
        "err:", errors,
        "provider:", providerKey,
        "visionMs:", visionMs
      );

      // Safety net: when every image failed and the request is non-streaming,
      // surface a 4xx so the client sees the failure on turn 1 instead of
      // getting a degraded reply that taints subsequent turns. Streaming
      // requests fall through (placeholders forwarded) since we cannot easily
      // change status mid-response.
      if (convertedCount === 0 && errors > 0 && parsedBody.stream !== true) {
        return jsonErrorResponse(
          502,
          `Vision provider failed for all ${errors} image attachment(s); request not forwarded. Start a fresh conversation after fixing the vision backend.`,
          "vision_unavailable",
          "upstream_error"
        );
      }
    }

    // Pre-stream budget guard for Vercel Edge: the platform requires an
    // initial Response within ~25s. If vision + reasoning injection have
    // already eaten most of the budget, fail fast with a clear error rather
    // than getting silently killed by the platform mid-fetch. Disabled when
    // not running on Vercel (Docker has no such limit).
    if (process.env.VERCEL) {
      const elapsedMs = Date.now() - t0;
      const budgetMs = parseInt(process.env.PRESTREAM_BUDGET_MS || "", 10) || 22000;
      if (elapsedMs > budgetMs) {
        diag("PRESTREAM_BUDGET_EXCEEDED", "elapsedMs:", elapsedMs, "budgetMs:", budgetMs);
        return jsonErrorResponse(
          504,
          `Pre-stream work exceeded the ${budgetMs}ms budget on Vercel Edge (took ${elapsedMs}ms). Most likely cause: a slow vision API call. Lower VISION_TIMEOUT_MS, raise VISION_CONCURRENCY, or send fewer images per turn.`,
          "prestream_timeout",
          "upstream_error"
        );
      }
    }
  }

  // Azure endpoints reject requests carrying unknown headers or dual auth,
  // so start from an empty set instead of mutating while iterating Headers.
  // Azure Foundry Kimi uses the generic OpenAI-compatible Kimi route, but it
  // has the same header sensitivity: EdgeOne may add large platform headers,
  // and Azure rejects those with HTTP 431 if we forward them upstream.
  const isAzureProvider = providerKey === "azureopenai" || providerKey === "azureanthropic";
  const isAnthropicCompat = providerKey === "anthropiccompat";
  const isAzureFoundryKimi = providerKey === "kimi" && isAzureFoundryKimiEndpoint(provider.url);
  const usesAzureHeaderIsolation = isAzureProvider || isAnthropicCompat || isAzureFoundryKimi;
  const headers = usesAzureHeaderIsolation ? new Headers() : new Headers(req.headers);

  // Build dynamic host header. Prefer the hostname from provider.url so
  // UPSTREAM_* overrides (e.g. MiMo Token Plan) send Host matching the target.
  // Azure Foundry Kimi uses upstreamUrl because provider.url is the API base.
  if (isAzureFoundryKimi) {
    try {
      headers.set("host", new URL(upstreamUrl).hostname);
    } catch {
      if (provider.host) headers.set("host", provider.host);
    }
  } else {
    let hostHeader = "";
    try {
      if (provider.url) hostHeader = new URL(provider.url).hostname;
    } catch { /* fall through */ }
    if (!hostHeader && provider.host) hostHeader = provider.host;
    if (!hostHeader) {
      try {
        hostHeader = new URL(upstreamUrl).hostname;
      } catch { /* ignore */ }
    }
    if (hostHeader) headers.set("host", hostHeader);
  }

  // Clean up headers that shouldn't leak upstream
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("content-length");
  headers.delete("content-type");
  headers.delete("transfer-encoding");
  headers.delete("accept-encoding");
  headers.set("content-type", "application/json");
  headers.set("accept-encoding", "identity");

  // Build dynamic auth header AFTER cleanup so it's not accidentally deleted.
  const authValue = provider.authHeaderPrefix + providerSecret;
  headers.set(provider.authHeaderName, authValue);

  // Apply provider-specific extra headers (e.g. anthropic-version for Azure)
  if (provider.extraHeaders) {
    for (const [k, v] of Object.entries(provider.extraHeaders)) {
      headers.set(k, v);
    }
  }

  if (openAICompatChatCacheRemote && openAICompatChatRemoteSession?.value) {
    headers.set("Session_id", openAICompatChatRemoteSession.value);
  }
  if (openAICompatResponsesHaloCache && openAICompatResponsesHaloSession?.value) {
    headers.set("Session_id", openAICompatResponsesHaloSession.value);
  }

  if (providerKey === "openaicompat" && pathParam === "chat/completions" && !openaiCompatResponses) {
    const chatCacheMode = openAICompatChatCacheRemote
      ? "remote"
      : (openAICompatChatCacheFacade ? "facade" : "passthrough");
    diag("OAI_CHAT_REQUEST_SHAPE",
         "provider:", providerKey,
         "model:", safeLogToken(upstreamModelName || parsedBody?.model || ""),
         "mode:", chatCacheMode,
         "messages:", Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : 0,
         "input:", Array.isArray(parsedBody?.input) ? parsedBody.input.length : 0,
         "tools:", Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
         "tool_choice:", summarizeToolChoiceForLog(parsedBody?.tool_choice),
         "stream:", parsedBody?.stream === true,
         "include_usage:", parsedBody?.stream_options?.include_usage === true,
         "promptKey:", String(parsedBody?.prompt_cache_key || "").trim() !== "",
         "session:", Boolean(headers.get("Session_id")));
  }

  // Dump the exact request being sent to Azure for debugging.
  // Gate behind DEBUG to avoid logging user prompts in production.
  if (DEBUG && usesAzureHeaderIsolation) {
    const hdrObj = {};
    headers.forEach((v, k) => (hdrObj[k] = v));
    // Redact auth keys from logs
    if (hdrObj["api-key"]) hdrObj["api-key"] = "***";
    if (hdrObj["x-api-key"]) hdrObj["x-api-key"] = "***";
    if (hdrObj["authorization"]) hdrObj["authorization"] = "***";
    diag(
      "UPSTREAM_REQUEST_DUMP",
      "url:", upstreamUrl,
      "method:", req.method,
      "headers:", JSON.stringify(hdrObj),
      "bodyLen:", (bodyText || "").length,
      "model:", parsedBody?.model,
      "stream:", parsedBody?.stream,
      "msgCount:", parsedBody?.messages?.length,
      "thinkingType:", parsedBody?.thinking?.type,
    );
  }

  // Connect-phase timeout (cleared as soon as headers arrive — never aborts the
  // streaming body). Safe to apply on Docker too; default 15s, override via
  // UPSTREAM_CONNECT_TIMEOUT_MS (set to 0 to disable).
  const connectTimeoutMs = (() => {
    const raw = parseInt(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || "", 10);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 15000;
  })();

  const fetchUpstream = async (requestBodyText) => {
    const connectController = connectTimeoutMs > 0 ? new AbortController() : null;
    const connectTimer = connectController
      ? setTimeout(() => connectController.abort(), connectTimeoutMs)
      : null;
    try {
      const res = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: requestBodyText || null,
        ...(connectController ? { signal: connectController.signal } : {}),
      });
      if (connectTimer) clearTimeout(connectTimer);
      return res;
    } catch (err) {
      if (connectTimer) clearTimeout(connectTimer);
      throw err;
    }
  };

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstream(bodyText);
  } catch (err) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    log("UPSTREAM_ERROR", err?.name, err?.message);
    return new Response(
      JSON.stringify({
        error: {
          message: isTimeout
            ? `Upstream provider timed out (>${connectTimeoutMs}ms connecting)`
            : `Upstream fetch failed: ${err?.message}`,
          type: "upstream_error",
          code: isTimeout ? "upstream_timeout" : "upstream_fetch_error",
        },
      }),
      {
        status: 504,
        headers: { "content-type": "application/json" },
      }
    );
  }

  let contentType = upstreamRes.headers.get("content-type") || "";
  let isStream = contentType.includes("text/event-stream");
  log("UPSTREAM_STATUS", upstreamRes.status, "provider:", providerKey, "stream:", isStream);

  // Some OpenAI-compatible Responses gateways accept native custom tools and
  // function tools separately, but 5xx when both appear in the same request.
  // Retry once with the native custom/apply_patch tools omitted, preserving
  // the function tools that Cursor also supplied.
  if (openaiCompatResponses && upstreamRes.status >= 500) {
    const fallback = openAICompatResponsesToolFallback(providerKey, parsedBody);
    if (fallback.changed) {
      const fallbackBodyText = JSON.stringify(fallback.parsedBody);
      diag("OAI_TOOL_FALLBACK_RETRY",
        "status:", upstreamRes.status,
        "droppedNative:", fallback.droppedNative,
        "functionTools:", fallback.functionTools);
      try {
        upstreamRes = await fetchUpstream(fallbackBodyText);
        parsedBody = fallback.parsedBody;
        bodyText = fallbackBodyText;
        contentType = upstreamRes.headers.get("content-type") || "";
        isStream = contentType.includes("text/event-stream");
        log("UPSTREAM_STATUS_RETRY", upstreamRes.status, "provider:", providerKey, "stream:", isStream);
      } catch (err) {
        const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        log("UPSTREAM_RETRY_ERROR", err?.name, err?.message);
        return new Response(
          JSON.stringify({
            error: {
              message: isTimeout
                ? `Upstream provider timed out (>${connectTimeoutMs}ms connecting) during compatibility retry`
                : `Upstream compatibility retry failed: ${err?.message}`,
              type: "upstream_error",
              code: isTimeout ? "upstream_timeout" : "upstream_fetch_error",
            },
          }),
          {
            status: 504,
            headers: { "content-type": "application/json" },
          }
        );
      }
    }
  }

  // Some OpenAI-compatible Responses gateways reject or lose
  // previous_response_id state. Retry once in stateless mode with the full
  // input array so Cursor gets an answer. Unsupported upstreams are suppressed
  // for a TTL; stale IDs are deleted so the retry can refresh the oairesp key.
  if (
    openaiCompatResponses
    && parsedBody?.previous_response_id
    && openAICompatStatelessRetryInput
    && (upstreamRes.status === 400 || upstreamRes.status === 404)
  ) {
    const errText = await upstreamRes.clone().text().catch(() => "");
    const previousResponseFailureKind = openAICompatPreviousResponseFailureKind(upstreamRes.status, errText);
    if (
      previousResponseFailureKind &&
      (previousResponseFailureKind !== "tool_output_missing" || !openAICompatSub2ApiCache)
    ) {
      if (previousResponseFailureKind === "unsupported") {
        markOpenAICompatPreviousResponseUnsupportedScope(respIdChainScope);
        azureReplyKey = null;
      } else if (previousResponseFailureKind === "not_found" && respIdPreviousKvKey) {
        await kvDelete(respIdPreviousKvKey);
      }
      const retryBody = cloneJson(parsedBody);
      retryBody.input = cloneJson(openAICompatStatelessRetryInput);
      delete retryBody.previous_response_id;
      const retryNormalized = normalizeOpenAICompatResponsesInputContent(providerKey, retryBody).parsedBody;
      const retryBodyText = JSON.stringify(retryNormalized);
      const retryTag = previousResponseFailureKind === "unsupported"
        ? "OAI_PREV_RESP_UNSUPPORTED_RETRY"
        : previousResponseFailureKind === "tool_output_missing"
          ? "OAI_TOOL_OUTPUT_RETRY"
          : "OAI_PREV_RESP_NOT_FOUND_RETRY";
      diag(retryTag,
        "status:", upstreamRes.status,
        "inputItems:", retryNormalized.input?.length || 0);
      try {
        upstreamRes = await fetchUpstream(retryBodyText);
        parsedBody = retryNormalized;
        bodyText = retryBodyText;
        contentType = upstreamRes.headers.get("content-type") || "";
        isStream = contentType.includes("text/event-stream");
        log("UPSTREAM_STATUS_PREV_RETRY", upstreamRes.status, "provider:", providerKey, "stream:", isStream);
      } catch (err) {
        const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        log("UPSTREAM_PREV_RETRY_ERROR", err?.name, err?.message);
        return new Response(
          JSON.stringify({
            error: {
              message: isTimeout
                ? `Upstream provider timed out (>${connectTimeoutMs}ms connecting) during previous_response_id stateless retry`
                : `Upstream previous_response_id stateless retry failed: ${err?.message}`,
              type: "upstream_error",
              code: isTimeout ? "upstream_timeout" : "upstream_fetch_error",
            },
          }),
          {
            status: 504,
            headers: { "content-type": "application/json" },
          }
        );
      }
    }
  }

  // Log upstream errors with response body for debugging (always-on).
  // Cap the captured preview so a multi-MB Azure error payload doesn't
  // double memory pressure on the failing path or flood log lines.
  if (upstreamRes.status >= 400) {
    const cloned = upstreamRes.clone();
    const errText = await cloned.text().catch(() => "(unreadable)");
    const ERROR_BODY_MAX = 2000;
    const preview = errText.length > ERROR_BODY_MAX
      ? errText.slice(0, ERROR_BODY_MAX) + `…(truncated ${errText.length - ERROR_BODY_MAX} chars)`
      : errText;
    diag("UPSTREAM_ERROR_STATUS", upstreamRes.status, "provider:", providerKey, "body:", preview);
  }

  if (!isStream) {
    const text = await upstreamRes.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return new Response(text, {
        status: upstreamRes.status,
        headers: { "content-type": contentType || "text/plain" },
      });
    }

    // Convert Anthropic non-streaming response to OpenAI format.
    // Extract and cache thinking blocks BEFORE mapping, since the mapper
    // discards them (only text/tool_use blocks survive the conversion).
    if (providerKey === "azureanthropic" || providerKey === "anthropiccompat") {
      const anthropicThinkingEnabled = providerKey === "azureanthropic"
        || (providerKey === "anthropiccompat" && process.env.ANTHROPICCOMPAT_THINKING_CACHE === "true");
      if (anthropicThinkingEnabled && parsedBody?.thinking?.type === "adaptive" && originalMessages) {
        const claudeThinkKey = "claude_thinking:" + await normalizedConversationHash(
          originalMessages, originalMessages.length, scope
        );
        const thinkingBlocks = extractClaudeThinkingBlocks(json);
        if (thinkingBlocks) {
          diag("CLAUDE_THINKING_WRITE_SOURCE",
               "key:", claudeThinkKey,
               "msgCount:", originalMessages?.length,
               "roles:", originalMessages?.map((m, i) => `${i}:${m.role || "?"}`).join(","));
          await kvSet(claudeThinkKey, JSON.stringify(thinkingBlocks))
            .catch((err) => diag("CLAUDE_THINKING_WRITE_ERROR", err?.message));
          const totalChars = thinkingBlocks.reduce((sum, b) => sum + (typeof b.thinking === "string" ? b.thinking.length : 0), 0);
          diag("CLAUDE_THINKING_CACHED", "key:", claudeThinkKey, "blocks:", thinkingBlocks.length, "chars:", totalChars);
        }
      }
      json = mapAnthropicResponseToOpenAI(json);
    }

    // Convert Responses API output to Chat Completions format
    if (providerKey === "azureopenai" || openaiCompatResponses) {
      const azureRespId = json.id;
      // Mirror the stream-side cache guard: only persist response IDs for
      // turns that actually completed. A response with status=incomplete /
      // failed / cancelled cannot be replayed via previous_response_id —
      // caching it would 400 the next turn and burn a free retry.
      const azureRespStatus = json.status || "completed";
      const cacheRespIdTag = openaiCompatResponses ? "CACHE_OAI_RESP_ID" : "CACHE_AZ_RESP_ID";
      const skipCacheRespIdTag = openaiCompatResponses ? "SKIP_CACHE_OAI_RESP_ID" : "SKIP_CACHE_AZ_RESP_ID";
      json = mapResponsesToOpenAI(json);
      if (azureRespId && azureReplyKey) {
        if (azureRespStatus === "completed") {
          log(cacheRespIdTag, "key:", azureReplyKey, "id:", azureRespId);
          await kvSet(respIdCachePrefix + azureReplyKey, azureRespId);
        } else {
          log(skipCacheRespIdTag, "key:", azureReplyKey, "id:", azureRespId, "status:", azureRespStatus);
        }
      }
    }

    if (openAICompatChatCacheUsageFacade) {
      const cacheUsage = normalizeOpenAICompatChatCacheUsage(json);
      json = cacheUsage.json;
      if (cacheUsage.changed) {
        diag("OAI_CHAT_CACHE_USAGE",
             "provider:", providerKey,
             "model:", safeLogToken(upstreamModelName || json?.model || ""),
             "cached_tokens:", cacheUsage.cachedTokens);
      }
    }

    json = withPublicResponseModel(json, responseModelName, Boolean(azureAliasInfo) || Boolean(compatAliasInfo) || providerKey === "glm" || providerKey === "fireworks");

    const reasoning = readReasoning(providerKey, json.choices?.[0]?.message);
    if (hasReasoningValue(reasoning) && replyReasoningKey) {
      log("CACHE non-stream key:", replyReasoningKey);
      await kvSet(replyReasoningKey, serializeReasoning(providerKey, reasoning));
    }
    log("NONSTREAM_DONE", "choices:", json.choices?.length, "reasoning_chars:", reasoningSize(reasoning));
    diag("RES", upstreamRes.status, "provider:", providerKey, "ms:", Date.now() - t0);
    return new Response(JSON.stringify(stripResponseChunk(json)), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Streaming timeout: defaults to 280s on Vercel (under the 300s limit),
  // 110s on EdgeOne Cloud Functions (under the 120s maxDuration), or 0 (disabled).
  // Also clamps to remaining platform budget so pre-stream work doesn't eat
  // into the wall-clock limit.
  const streamTimeoutRaw = process.env.STREAM_TIMEOUT_SECONDS;
  const streamTimeoutConfigured = streamTimeoutRaw != null && String(streamTimeoutRaw).trim() !== "";
  let streamTimeoutSec = parseInt(streamTimeoutRaw || "", 10);
  // A negative or non-numeric configured value silently falls back to the
  // default if we don't guard here, which masks operator misconfiguration.
  // Log loudly and treat it as unset so the platform default applies.
  if (streamTimeoutConfigured && (!Number.isFinite(streamTimeoutSec) || streamTimeoutSec < 0)) {
    diag("STREAM_TIMEOUT_INVALID", "raw:", streamTimeoutRaw, "fallback: platform default");
    streamTimeoutSec = NaN;
  }
  const elapsedSec = (Date.now() - t0) / 1000;
  const isVercel = Boolean(process.env.VERCEL);
  const isEdgeOneCloud = process.env.EDGEONE_CLOUD_FUNCTION === "true";
  const platformLimit = isVercel ? 295 : (isEdgeOneCloud ? 115 : Infinity);
  const maxStreamSec = platformLimit - elapsedSec - 5; // 5s safety margin
  const defaultStreamSec = isVercel ? 280 : (isEdgeOneCloud ? 110 : 0);
  const capToPlatform = (seconds) => Number.isFinite(maxStreamSec)
    ? Math.max(1, Math.min(seconds, maxStreamSec))
    : seconds;
  const effectiveTimeoutSec = streamTimeoutSec > 0
    ? capToPlatform(streamTimeoutSec)
    : (streamTimeoutConfigured && streamTimeoutSec === 0
      ? 0
      : (defaultStreamSec > 0 ? capToPlatform(defaultStreamSec) : 0));

  log("STREAM_START", "timeout:", effectiveTimeoutSec > 0 ? effectiveTimeoutSec + "s" : "none",
      "provider:", providerKey);

  // Guard against an upstream that advertises text/event-stream but returns no
  // body (misbehaving providers, 204-on-stream). Without this, getReader() throws.
  if (!upstreamRes.body) {
    log("STREAM_EMPTY_BODY", upstreamRes.status);
    return new Response(null, {
      status: upstreamRes.status,
      headers: { "content-type": contentType || "text/event-stream" },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const reader = upstreamRes.body.getReader();
  let timedOut = false;
  let streamTimer = null;

  if (effectiveTimeoutSec > 0) {
    streamTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, effectiveTimeoutSec * 1000);
  }

  (async () => {
    let buffer = "";
    let accReasoning = null;
    let accContent = "";
    let accRefusal = "";
    let contentCapHit = false;
    let refusalCapHit = false;
    // Bounded append for plain-string accumulators. The forwarded SSE still
    // carries the full upstream text — only the proxy-side string used for
    // logging / size checks is truncated, so a 100MB reply doesn't pin 100MB
    // of heap on the function instance.
    function appendCapped(prev, addition, cap, label, flagSetter) {
      if (!addition) return prev;
      if (prev.length >= cap) {
        if (flagSetter) flagSetter();
        return prev;
      }
      if (prev.length + addition.length <= cap) return prev + addition;
      if (flagSetter) flagSetter();
      const room = cap - prev.length;
      log("STREAM_ACC_CAP_REACHED", "label:", label, "cap:", cap);
      return prev + addition.slice(0, room);
    }
    let doneSeen = false;
    let lastCachedReasoningSize = 0;
    let azureResponseId = null; // captured from response.created for KV write
    let azureResponseTerminalStatus = null;
    let azureResponseIncompleteReason = null;
    let azureFunctionDeltaCount = 0;
    let azureStreamSummaryLogged = false;
    // Track Anthropic tool_use blocks by index for converting input_json_delta
    // to OpenAI-style tool_calls format.
    const anthropicToolState = new Map(); // index -> { id, name, partialJson }

    // Track Azure Responses API function_call items for converting
    // response.function_call_arguments.delta to OpenAI tool_calls.
    const responsesToolState = new Map(); // call_id -> { id, name, partialJson }
    let responsesToolCallSeen = false;

    // Track Claude thinking blocks for KV caching (azureanthropic + adaptive thinking).
    // Store the content_block object from content_block_start directly, then mutate
    // its fields as thinking_delta / signature_delta arrive.  This preserves the
    // exact shape including empty-string fields (e.g. thinking: "" for omitted
    // thinking) so the cached block round-trips unchanged.
    const claudeThinkBlocks = new Map(); // index -> content_block object
    const claudeThinkActive = (providerKey === "azureanthropic" ||
      (providerKey === "anthropiccompat" && process.env.ANTHROPICCOMPAT_THINKING_CACHE === "true")) &&
      parsedBody?.thinking?.type && parsedBody?.thinking?.type !== "disabled";
    let claudeThinkingCached = false;
    let azureRespCached = false;

    // Pre-compute the Claude thinking cache key using normalized hash so
    // the write-side key matches the read-side key regardless of content
    // format changes that Cursor may apply between turns.
    let claudeThinkKey = null;
    if (claudeThinkActive && originalMessages) {
      claudeThinkKey = "claude_thinking:" + await normalizedConversationHash(
        originalMessages, originalMessages.length, scope
      );
    }

    // Aggregate Anthropic SSE event counts per stream to reduce DEBUG log volume.
    // Per-event logging was ~800 log lines per stream; this collapses to 1.
    const anthropicEventCounts = { total: 0 };
    const azureEventCounts = { total: 0 };
    const openAICompatChatStreamDiag = providerKey === "openaicompat" && !openaiCompatResponses;
    let openAICompatChatStreamSummaryLogged = false;
    const openAICompatChatStreamStats = {
      chunks: 0,
      contentDeltas: 0,
      reasoningDeltas: 0,
      toolCallChunks: 0,
      toolCallStarts: 0,
      toolArgDeltas: 0,
      usageChunks: 0,
      parseErrors: 0,
      cachedTokens: null,
      finish: "(none)",
    };
    const openAICompatChatToolIds = new Set();
    let streamReadError = false;

    function countAzureEvent(eventName) {
      const key = eventName || "unknown";
      azureEventCounts.total++;
      azureEventCounts[key] = (azureEventCounts[key] || 0) + 1;
    }

    function logAzureStreamSummary(reason) {
      if (!(providerKey === "azureopenai" || openaiCompatResponses) || azureStreamSummaryLogged || azureEventCounts.total === 0) return;
      azureStreamSummaryLogged = true;
      diag(openaiCompatResponses ? "OAI_STREAM_SUMMARY" : "AZURE_STREAM_SUMMARY",
           "reason:", reason,
           "content:", accContent.length,
           "refusal:", accRefusal.length,
           "functionArgDeltas:", azureFunctionDeltaCount,
           "events:", JSON.stringify(azureEventCounts));
      if (accRefusal) {
        log("AZURE_REFUSAL_PREVIEW", accRefusal.slice(0, 240));
      }
    }

    function logOpenAICompatChatStreamSummary(reason) {
      if (!openAICompatChatStreamDiag || openAICompatChatStreamSummaryLogged) return;
      openAICompatChatStreamSummaryLogged = true;
      diag("OAI_CHAT_STREAM_SUMMARY",
           "provider:", providerKey,
           "reason:", reason,
           "chunks:", openAICompatChatStreamStats.chunks,
           "contentDeltas:", openAICompatChatStreamStats.contentDeltas,
           "content:", accContent.length,
           "reasoningDeltas:", openAICompatChatStreamStats.reasoningDeltas,
           "reasoning:", reasoningSize(accReasoning),
           "toolCalls:", openAICompatChatStreamStats.toolCallChunks,
           "toolStarts:", openAICompatChatStreamStats.toolCallStarts,
           "toolArgDeltas:", openAICompatChatStreamStats.toolArgDeltas,
           "finish:", openAICompatChatStreamStats.finish || "(none)",
           "usageChunks:", openAICompatChatStreamStats.usageChunks,
           "cached_tokens:", openAICompatChatStreamStats.cachedTokens ?? "(none)",
           "doneSeen:", doneSeen,
           "parseErrors:", openAICompatChatStreamStats.parseErrors);
    }

    function updateOpenAICompatChatStreamStats(json) {
      if (!openAICompatChatStreamDiag || !json || typeof json !== "object") return;
      openAICompatChatStreamStats.chunks++;
      if (json.usage) {
        openAICompatChatStreamStats.usageChunks++;
        const cachedTokens = openAICompatChatCachedTokens(json);
        if (cachedTokens != null) {
          openAICompatChatStreamStats.cachedTokens = cachedTokens;
        }
      }
      const choices = Array.isArray(json.choices) ? json.choices : [];
      for (const choice of choices) {
        if (choice?.finish_reason != null) {
          openAICompatChatStreamStats.finish = safeLogToken(choice.finish_reason);
        }
        const choiceDelta = choice?.delta;
        if (!choiceDelta || typeof choiceDelta !== "object") continue;
        if (choiceDelta.content != null) {
          openAICompatChatStreamStats.contentDeltas++;
        }
        if (hasReasoningValue(readReasoning(providerKey, choiceDelta))) {
          openAICompatChatStreamStats.reasoningDeltas++;
        }
        const toolCalls = Array.isArray(choiceDelta.tool_calls) ? choiceDelta.tool_calls : [];
        if (toolCalls.length > 0) {
          openAICompatChatStreamStats.toolCallChunks++;
          for (const toolCall of toolCalls) {
            const toolIdentity = toolCall?.id
              || `${choice?.index ?? 0}:${toolCall?.index ?? 0}:${toolCall?.function?.name || ""}`;
            if ((toolCall?.id || toolCall?.function?.name) && !openAICompatChatToolIds.has(toolIdentity)) {
              openAICompatChatToolIds.add(toolIdentity);
              openAICompatChatStreamStats.toolCallStarts++;
            }
            if (toolCall?.function?.arguments != null && String(toolCall.function.arguments) !== "") {
              openAICompatChatStreamStats.toolArgDeltas++;
            }
          }
        }
      }
    }

    async function cacheClaudeThinking() {
      if (claudeThinkingCached || !claudeThinkKey || claudeThinkBlocks.size === 0) return;
      // Serialize blocks in index order.  The objects are the original
      // content_block_start payloads with mutated fields, so the shape matches
      // the final non-streaming content array exactly.
      const sorted = [...claudeThinkBlocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]) => block);
      // Guard against broken streams: if any thinking block lacks a signature,
      // the block is incomplete (stream died after thinking_delta but before
      // signature_delta).  Caching and re-injecting an unverified block would
      // break the next turn.  redacted_thinking blocks don't carry signatures.
      const incomplete = sorted.some((b) => b.type === "thinking" && !b.signature);
      if (incomplete) {
        claudeThinkingCached = true;
        diag("CLAUDE_THINKING_INCOMPLETE", "key:", claudeThinkKey,
             "blocks:", sorted.length, "hint: stream ended before signature_delta");
        return;
      }
      await kvSet(claudeThinkKey, JSON.stringify(sorted))
        .catch((err) => diag("CLAUDE_THINKING_WRITE_ERROR", err?.message));
      claudeThinkingCached = true;
      const totalChars = sorted.reduce((sum, b) => sum + (typeof b.thinking === "string" ? b.thinking.length : 0), 0);
      diag("CLAUDE_THINKING_WRITE_SOURCE",
           "key:", claudeThinkKey,
           "msgCount:", originalMessages?.length,
           "roles:", originalMessages?.map((m, i) => `${i}:${m.role || "?"}`).join(","));
      diag("CLAUDE_THINKING_CACHED", "key:", claudeThinkKey, "blocks:", sorted.length, "chars:", totalChars);
    }

    async function cacheReasoningSnapshot(force = false) {
      if (!replyReasoningKey || !hasReasoningValue(accReasoning)) return;
      const size = reasoningSize(accReasoning);
      if (!force) {
        const minDelta = providerKey === "minimax" ? 1 : 256;
        if (size === 0 || size < lastCachedReasoningSize + minDelta) return;
      }
      lastCachedReasoningSize = size;
      log("CACHE stream key:", replyReasoningKey, "size:", size, "force:", force);
      // Mid-stream snapshots are fire-and-forget so KV latency does not stall
      // the SSE forward path. Forced writes (at [DONE] / finally) still await
      // to guarantee durability before the request ends.
      const writePromise = kvSet(replyReasoningKey, serializeReasoning(providerKey, accReasoning))
        .catch((err) => log("CACHE_WRITE_ERROR", err?.message));
      if (force) await writePromise;
    }

    async function cacheAzResponseId() {
      if (!azureResponseId || !azureReplyKey || azureRespCached) return;
      const cacheRespIdTag = openaiCompatResponses ? "CACHE_OAI_RESP_ID" : "CACHE_AZ_RESP_ID";
      const skipCacheRespIdTag = openaiCompatResponses ? "SKIP_CACHE_OAI_RESP_ID" : "SKIP_CACHE_AZ_RESP_ID";
      const writeErrorTag = openaiCompatResponses ? "CACHE_OAI_WRITE_ERROR" : "CACHE_AZ_WRITE_ERROR";
      if (azureResponseTerminalStatus && azureResponseTerminalStatus !== "completed") {
        azureRespCached = true;
        log(skipCacheRespIdTag,
            "key:", azureReplyKey,
            "id:", azureResponseId,
            "status:", azureResponseTerminalStatus,
            "incomplete:", azureResponseIncompleteReason || "(none)");
        return;
      }
      azureRespCached = true;
      log(cacheRespIdTag, "key:", azureReplyKey, "id:", azureResponseId);
      await kvSet(respIdCachePrefix + azureReplyKey, azureResponseId)
        .catch((err) => log(writeErrorTag, err?.message));
    }

    try {
      let currentResponsesEvent = ""; // track event: line for Azure OpenAI Responses SSE
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const rawLines = buffer.split("\n");
        buffer = rawLines.pop();
        // Strip trailing \r so CRLF line endings don't leak into our re-emitted
        // SSE frames (which use \n\n terminators).
        const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

        for (const line of lines) {
          // For Azure Anthropic, skip event: lines entirely — we convert data lines
          // into OpenAI-compatible format and emit only the transformed chunks.
          //
          // For Azure OpenAI and OpenAI-compatible Responses API, track event:
          // lines to use when processing data: lines — the event name tells us
          // what type of delta it is.
          if ((providerKey === "azureopenai" || openaiCompatResponses) && line.startsWith("event: ")) {
            currentResponsesEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            if (!(providerKey === "azureanthropic" || providerKey === "anthropiccompat" || providerKey === "azureopenai" || openaiCompatResponses)) {
              if (line.trim()) await writer.write(encoder.encode(line + "\n"));
            }
            continue;
          }

          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            // Avoid double [DONE] emission when response.completed was already
            // handled above (Azure Responses API may emit both).
            if (doneSeen) continue;
            doneSeen = true;
            const reasoningChars = reasoningSize(accReasoning);
            log("STREAM_DONE", "reasoning:", reasoningChars, "content:", accContent.length);
            if (reasoningChars > 5000 && accContent.length < 100) {
              log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
            }
            await cacheReasoningSnapshot(true);
            await cacheAzResponseId();
            await cacheClaudeThinking();
            logAzureStreamSummary("[DONE]");
            logOpenAICompatChatStreamSummary("[DONE]");
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            let json = JSON.parse(data);

            // Transform Anthropic SSE events into OpenAI-compatible format.
            // Anthropic uses events like content_block_delta with delta.text_delta,
            // but the proxy and Cursor expect choices[0].delta.content.
            if (providerKey === "azureanthropic" || providerKey === "anthropiccompat") {
              // Count ALL events per stream BEFORE any suppression branches,
              // so thinking_delta / signature_delta / content_block_start for
              // thinking / redacted_thinking are included in the aggregated log.
              anthropicEventCounts.total++;
              let evType = json.type || "unknown";
              // For compound event types, append the subtype so
              // thinking_delta/signature_delta/text_delta are distinguishable
              // and content_block_start subtypes (thinking, text, tool_use,
              // redacted_thinking) are tracked separately.
              if (json.type === "content_block_delta" && json.delta?.type) {
                evType = "content_block_delta:" + json.delta.type;
              } else if (json.type === "content_block_start" && json.content_block?.type) {
                evType = "content_block_start:" + json.content_block.type;
              }
              anthropicEventCounts[evType] = (anthropicEventCounts[evType] || 0) + 1;

              // When adaptive thinking is active, suppress thinking_delta and
              // signature_delta events: update the cached content_block object
              // in place instead of forwarding to Cursor.  The content_block
              // from content_block_start is stored directly so its exact shape
              // (including empty-string fields like thinking: "" for omitted
              // thinking) round-trips unchanged.
              if (claudeThinkActive && json?.delta?.type === "thinking_delta") {
                const idx = json.index ?? 0;
                const block = claudeThinkBlocks.get(idx);
                if (block) block.thinking = (block.thinking || "") + (json.delta.thinking || "");
                continue;
              }
              if (claudeThinkActive && json?.delta?.type === "signature_delta") {
                const idx = json.index ?? 0;
                const block = claudeThinkBlocks.get(idx);
                if (block) block.signature = (block.signature || "") + (json.delta.signature || "");
                continue;
              }
              if (claudeThinkActive && json?.type === "content_block_start") {
                const ct = json?.content_block?.type;
                if (ct === "thinking" || ct === "redacted_thinking") {
                  // Store the block object directly — deltas will mutate its
                  // fields in place above.  For omitted thinking the block
                  // already carries thinking: "" which is preserved as-is.
                  claudeThinkBlocks.set(json.index ?? 0, { ...json.content_block });
                  continue;
                }
              }
              const mapped = mapAnthropicSSEToOpenAI(json, anthropicToolState);
              if (mapped === "[DONE]") {
                if (doneSeen) continue;
                doneSeen = true;
                log("STREAM_DONE_VIA_MESSAGE_STOP", "content:", accContent.length);
                await cacheReasoningSnapshot(true);
                await cacheClaudeThinking();
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                continue;
              }
              if (!mapped) continue; // skip events that produce no output
              json = mapped;
            }

            // Transform Azure Responses API SSE events into OpenAI-compatible format.
            // Responses API uses named events (event: response.output_text.delta)
            // with data payloads, unlike Anthropic's data-only content_block_delta.
            if ((providerKey === "azureopenai" || openaiCompatResponses) && (currentResponsesEvent || json?.type)) {
              const responsesEvent = json?.type || currentResponsesEvent;
              countAzureEvent(responsesEvent);
              if (responsesEvent === "response.refusal.delta") {
                accRefusal = appendCapped(
                  accRefusal,
                  json?.delta || "",
                  ACC_REFUSAL_CAP,
                  "refusal",
                  () => { refusalCapHit = true; },
                );
              } else if (
                responsesEvent === "response.function_call_arguments.delta" ||
                responsesEvent === "response.custom_tool_call_input.delta" ||
                responsesEvent === "response.apply_patch_call.delta" ||
                responsesEvent === "response.apply_patch_call_input.delta"
              ) {
                azureFunctionDeltaCount++;
              }

              if (responsesEvent === "error") {
                if (doneSeen) continue;
                doneSeen = true;
                const upstreamError = json?.error || json;
                const errMessage = upstreamError?.message || upstreamError?.code || "Upstream Responses stream error";
                const errType = upstreamError?.type || "upstream_stream_error";
                const errCode = upstreamError?.code || "responses_stream_error";
                diag(openaiCompatResponses ? "OAI_STREAM_ERROR" : "AZURE_STREAM_ERROR",
                     "message:", String(errMessage).slice(0, 500),
                     "type:", errType,
                     "code:", errCode);
                azureResponseTerminalStatus = "failed";
                await cacheReasoningSnapshot(true);
                logAzureStreamSummary("error");
                await writer.write(encoder.encode("data: " + JSON.stringify({
                  error: {
                    message: errMessage,
                    type: errType,
                    code: errCode,
                  },
                }) + "\n\n"));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              if (isResponsesToolDoneEvent(responsesEvent)) {
                const state = responsesToolStateForLog(responsesToolState, json);
                const argsText = responsesToolArgsForLog(json, state);
                const toolName = state?.name || json?.name || "(unknown)";
                diag(openaiCompatResponses ? "OAI_TOOL_CALL_DONE" : "AZURE_TOOL_CALL_DONE",
                     "provider:", providerKey,
                     "name:", safeLogToken(toolName),
                     "toolIndex:", state?.toolIndex ?? "(none)",
                     "responsesIndex:", json?.output_index ?? "(none)",
                     "argChars:", argsText.length,
                     "argKeys:", summarizeJsonArgKeysForLog(argsText));
                log(openaiCompatResponses ? "OAI_TOOL_ARG_SHAPE" : "AZURE_TOOL_ARG_SHAPE",
                    "provider:", providerKey,
                    "name:", safeLogToken(toolName),
                    "toolIndex:", state?.toolIndex ?? "(none)",
                    "responsesIndex:", json?.output_index ?? "(none)",
                    ...summarizeToolArgShapeForLog(toolName, argsText));
              }

              let mapped = null;
              const preMappedToolState = responsesToolStateForLog(responsesToolState, json);
              const shouldSanitizeSubagentArgs = openaiCompatResponses
                && isCursorSubagentToolName(preMappedToolState?.name || json?.name);
              const shouldSanitizeShellArgs = openaiCompatResponses
                && isCursorShellToolName(preMappedToolState?.name || json?.name);

              if ((shouldSanitizeSubagentArgs || shouldSanitizeShellArgs) && isResponsesToolArgDeltaEvent(responsesEvent)) {
                // Let mapResponsesSSEToOpenAI update partialJson, then suppress
                // the raw delta so Cursor never sees args that need local repair.
                mapResponsesSSEToOpenAI(responsesEvent, json, responsesToolState);
                continue;
              }

              const shouldRepairDefaultToolDoneArgs = openaiCompatResponses
                && !openAICompatSub2ApiCache
                && !shouldSanitizeSubagentArgs
                && !shouldSanitizeShellArgs
                && isResponsesToolDoneEvent(responsesEvent);

              if (shouldSanitizeSubagentArgs && isResponsesToolDoneEvent(responsesEvent)) {
                const argsText = responsesToolArgsForLog(json, preMappedToolState);
                const sanitized = sanitizeCursorSubagentArgsForLocal(argsText);
                if (sanitized.removed.length > 0) {
                  diag("OAI_SUBAGENT_ARGS_SANITIZED",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "toolIndex:", preMappedToolState?.toolIndex ?? "(none)",
                       "removed:", sanitized.removed.map((key) => safeLogToken(key)).join(","),
                       "argKeys:", summarizeJsonArgKeysForLog(sanitized.argsText));
                } else if (sanitized.parseError) {
                  diag("OAI_SUBAGENT_ARGS_SANITIZE_SKIP",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "reason:", "unparseable");
                }
                mapped = mapResponsesToolArgsChunkForProxy(preMappedToolState, sanitized.argsText);
              } else if (shouldSanitizeShellArgs && isResponsesToolDoneEvent(responsesEvent)) {
                const argsText = responsesToolArgsForLog(json, preMappedToolState);
                const sanitized = sanitizeCursorShellArgsForLocal(argsText);
                if (sanitized.removed.length > 0) {
                  diag("OAI_SHELL_ARGS_SANITIZED",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "toolIndex:", preMappedToolState?.toolIndex ?? "(none)",
                       "removed:", sanitized.removed.map((key) => safeLogToken(key)).join(","),
                       "reason:", "empty_pattern",
                       "argKeys:", summarizeJsonArgKeysForLog(sanitized.argsText));
                } else if (sanitized.parseError) {
                  diag("OAI_SHELL_ARGS_SANITIZE_SKIP",
                       "provider:", providerKey,
                       "name:", safeLogToken(preMappedToolState?.name || json?.name || "(unknown)"),
                       "reason:", "unparseable");
                }
                mapped = mapResponsesToolArgsChunkForProxy(preMappedToolState, sanitized.argsText);
              } else if (shouldRepairDefaultToolDoneArgs) {
                mapped = mapMissingResponsesToolArgsForProxy(
                  preMappedToolState,
                  responsesToolArgsForLog(json, preMappedToolState),
                );
              } else {
                mapped = mapResponsesSSEToOpenAI(responsesEvent, json, responsesToolState);
              }

              if (mapped) {
                const mappedToolCalls = mapped.choices?.[0]?.delta?.tool_calls;
                if (mappedToolCalls) {
                  responsesToolCallSeen = true;
                  if (responsesEvent === "response.output_item.added") {
                    const firstTool = mappedToolCalls[0] || {};
                    diag(openaiCompatResponses ? "OAI_TOOL_CALL_START" : "AZURE_TOOL_CALL_START",
                         "provider:", providerKey,
                         "name:", safeLogToken(firstTool.function?.name || "(unknown)"),
                         "toolIndex:", firstTool.index ?? "(none)",
                         "responsesIndex:", json?.output_index ?? "(none)");
                  }
                }
                json = mapped;
              } else {
                // Capture the response ID from the first SSE event so we can
                // write it to KV and enable previous_response_id chaining on
                // the next turn.
                if (responsesEvent === "response.created" && !azureResponseId) {
                  azureResponseId = json?.response?.id || null;
                  if (azureResponseId) {
                    log(openaiCompatResponses ? "STREAM_OAI_RESP_ID" : "STREAM_AZ_RESP_ID", "id:", azureResponseId);
                  }
                }
                // Emit downstream [DONE] when the Responses API signals completion.
                // Cursor expects OpenAI Chat Completions stream semantics, which
                // always terminate with data: [DONE].  Without this, a stream that
                // ends via response.completed (no raw [DONE] line) looks hung.
                if (responsesEvent === "response.completed" || responsesEvent === "response.incomplete") {
                  if (doneSeen) continue;
                  doneSeen = true;
                  const completed = json?.response || {};
                  azureResponseTerminalStatus = responsesEvent === "response.incomplete"
                    ? "incomplete"
                    : (completed.status || "completed");
                  azureResponseIncompleteReason = completed.incomplete_details?.reason || null;
                  diag(responsesEvent === "response.incomplete" ? "AZURE_RESPONSE_INCOMPLETE" : "AZURE_RESPONSE_COMPLETED",
                       "status:", completed.status || "(none)",
                       "error:", completed.error?.code || completed.error?.message || "(none)",
                       "incomplete:", completed.incomplete_details?.reason || "(none)");
                  log(responsesEvent === "response.incomplete" ? "STREAM_DONE_VIA_RESPONSE_INCOMPLETE" : "STREAM_DONE_VIA_RESPONSE_COMPLETED",
                      "content:", accContent.length);
                  await cacheReasoningSnapshot(true);
                  await cacheAzResponseId();
                  logAzureStreamSummary(responsesEvent);
                  if (responsesStreamIncludeUsage && completed.usage) {
                    const usage = mapResponsesUsageToOpenAI(completed.usage);
                    if (usage) {
                      const usageChunk = withPublicResponseModel({
                        id: completed.id || azureResponseId || "resp_unknown",
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: completed.model || "",
                        choices: [],
                        usage,
                      }, responseModelName, Boolean(azureAliasInfo) || Boolean(compatAliasInfo));
                      await writer.write(encoder.encode(
                        "data: " + JSON.stringify(stripResponseChunk(usageChunk)) + "\n\n"
                      ));
                    }
                  }
                  if (responsesToolCallSeen) {
                    const finishChunk = withPublicResponseModel({
                      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                    }, responseModelName, Boolean(azureAliasInfo) || Boolean(compatAliasInfo));
                    await writer.write(encoder.encode(
                      "data: " + JSON.stringify(stripResponseChunk(finishChunk)) + "\n\n"
                    ));
                  }
                  await writer.write(encoder.encode("data: [DONE]\n\n"));
                }
                continue; // skip events that produce no output
              }
            }

            if (openAICompatChatCacheUsageFacade) {
              const cacheUsage = normalizeOpenAICompatChatCacheUsage(json);
              json = cacheUsage.json;
              if (cacheUsage.changed) {
                diag("OAI_CHAT_CACHE_STREAM_USAGE",
                     "provider:", providerKey,
                     "model:", safeLogToken(upstreamModelName || json?.model || ""),
                     "cached_tokens:", cacheUsage.cachedTokens);
              }
            }

            updateOpenAICompatChatStreamStats(json);
            const delta = json.choices?.[0]?.delta;
            const chunkReasoning = readReasoning(providerKey, delta);
            accReasoning = updateStreamReasoning(providerKey, accReasoning, chunkReasoning);
            // Soft cap: DeepSeek/Kimi/GLM accumulate reasoning as a single
            // growing string; MiniMax replaces the object wholesale so already bounded.
            // We truncate the stored string but keep forwarding the SSE chunk
            // unchanged so clients still receive every token from upstream.
            if (typeof accReasoning === "string" && accReasoning.length > ACC_REASONING_CAP) {
              log("STREAM_ACC_CAP_REACHED", "label:", "reasoning", "cap:", ACC_REASONING_CAP);
              accReasoning = accReasoning.slice(0, ACC_REASONING_CAP);
            }
            if (hasReasoningValue(chunkReasoning)) {
              await cacheReasoningSnapshot();
            }
            if (delta?.content != null) {
              accContent = appendCapped(
                accContent,
                String(delta.content),
                ACC_CONTENT_CAP,
                "content",
                () => { contentCapHit = true; },
              );
            }
            json = withPublicResponseModel(json, responseModelName, Boolean(azureAliasInfo) || Boolean(compatAliasInfo) || providerKey === "glm" || providerKey === "fireworks");
            await writer.write(
              encoder.encode(
                "data: " + JSON.stringify(stripResponseChunk(json)) + "\n\n"
              )
            );
          } catch {
            if (openAICompatChatStreamDiag) {
              openAICompatChatStreamStats.parseErrors++;
            }
            await writer.write(encoder.encode(line + "\n\n"));
          }
        }
      }
    } catch (err) {
      // Expected on the timeout path: reader.cancel() makes the in-flight
      // reader.read() reject (typically "Stream was cancelled" / AbortError).
      // Without this catch the rejection escapes the unawaited IIFE and Vercel
      // surfaces it as an unhandled error in the function logs even though we
      // already emitted a graceful stream_timeout SSE frame to the client.
      // For genuine upstream stream failures (network drop mid-stream), log
      // once at diag level so they remain visible without being noisy.
      if (timedOut) {
        log("STREAM_READ_ABORTED_AFTER_TIMEOUT", err?.name, err?.message);
      } else {
        streamReadError = true;
        diag("STREAM_READ_ERROR", err?.name, err?.message);
        try {
          const errMsg = JSON.stringify({
            error: {
              message: `Upstream stream interrupted: ${err?.message || err?.name || "unknown error"}`,
              type: "upstream_error",
              code: "stream_read_error",
            },
          });
          await writer.write(encoder.encode("data: " + errMsg + "\n\n"));
        } catch {}
      }
    } finally {
      if (streamTimer) clearTimeout(streamTimer);

      if (timedOut) {
        const reasoningChars = reasoningSize(accReasoning);
        diag("STREAM_TIMEOUT", "reasoning:", reasoningChars, "content:", accContent.length,
            "timeout:", effectiveTimeoutSec + "s");
        if (reasoningChars > 5000 && accContent.length < 100) {
          log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
        }
        try {
          const timeoutMsg = JSON.stringify({
            error: {
              message: `Stream timed out after ${effectiveTimeoutSec}s. The model was still generating (reasoning: ${reasoningChars} chars, content: ${accContent.length} chars). Retry with a smaller prompt, or increase STREAM_TIMEOUT_SECONDS.`,
              type: "stream_timeout",
              code: "stream_timeout",
            },
          });
          await writer.write(encoder.encode("data: " + timeoutMsg + "\n\n"));
        } catch {}
      }

      if (!doneSeen && !timedOut && originalMessages && hasReasoningValue(accReasoning)) {
        const reasoningChars = reasoningSize(accReasoning);
        log("STREAM_FINALLY", "reasoning:", reasoningChars, "content:", accContent.length);
        if (reasoningChars > 5000 && accContent.length < 100) {
          log("LOW_CONTENT_WARNING", "reasoning:", reasoningChars, "content:", accContent.length);
        }
        await cacheReasoningSnapshot(true);
      }

      // Azure response ID may have been captured from response.created but
      // not yet cached — either because the stream ended via response.completed
      // (no data: [DONE]), or because originalMessages is null for Azure so
      // the reasoning guard above short-circuits.  Write it here when available
      // and the stream finished normally (not timed out).
      if (!timedOut) {
        await cacheAzResponseId();
        await cacheClaudeThinking();
      }
      if ((providerKey === "azureanthropic" || providerKey === "anthropiccompat") && anthropicEventCounts.total > 0) {
        log("ANTHROPIC_EVENTS", anthropicEventCounts);
      }
      logAzureStreamSummary(timedOut ? "timeout" : "finally");
      logOpenAICompatChatStreamSummary(timedOut ? "timeout" : (streamReadError ? "read_error" : "finally"));
      diag("RES", upstreamRes.status, "provider:", providerKey, "ms:", Date.now() - t0);
      await writer.close();
    }
  })().catch((err) => {
    // Last-resort guard: ensure no rejection escapes the unawaited IIFE.
    // Anything reaching here means the inner try/catch/finally itself threw
    // (e.g. writer.close() race after cancel). Logging only — the response
    // stream has already been returned to the client.
    diag("STREAM_PIPE_ERROR", err?.name, err?.message);
  });

  return new Response(readable, {
    status: upstreamRes.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
