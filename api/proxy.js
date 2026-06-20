export const config = { runtime: "edge" };

import { kvGet, kvSet } from "../lib/kv.js";
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
  normalizeAzureOpenAIInputContent,
  normalizeAzureOpenAITools,
  sanitizeAzureOpenAIBody,
} from "../lib/azure-openai.js";
import { checkProxyAuth, cleanEnvValue, jsonErrorResponse } from "../lib/auth.js";
import { cacheScopeUserId, conversationHash, normalizedConversationHash, sha256ImageHash } from "../lib/cache.js";
import {
  isModelDiscoveryRequest,
  modelDiscoveryResponse,
  normalizeParsedBodyModel,
  providerFromModel,
  publicModelId,
  resolveAzureAlias,
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
let proxyAuthWarningLogged = false;

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
  if (DEBUG) console.log("[cursorProxy:proxy]", ...args);
}

function diag(...args) {
  console.log("[cursorProxy:proxy]", ...args);
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

function upstreamApiKey(providerKey) {
  const meta = PROVIDERS[providerKey] ?? PROVIDERS.deepseek;
  return process.env[meta.apiKeyEnv] || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let azureReplyKey = null; // KV key for saving Azure response ID
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

  // Azure OpenAI Responses API uses "input" natively. Do not normalize native
  // Responses input items (input_text, output_text, function_call_output, etc.).
  // Azure OpenAI previous_response_id chaining via KV.
  //
  // Supports two input formats from the client:
  //   1. Legacy Chat Completions `messages` — renamed to `input` with
  //      tool-call normalization (role:"tool" → function_call_output,
  //      assistant.tool_calls → function_call items).
  //   2. Native Responses API `input` — items already in Responses format.
  //
  // When a prior assistant turn exists, try to recover the response ID from KV
  // and use previous_response_id chaining so Azure reuses server-side context
  // instead of re-reasoning from scratch on every turn. Falls back to stateless
  // full-input-array mode on KV miss.
  if (providerKey === "azureopenai") {
    // Provider-wide guard: store:false (privacy/compliance opt-out) is
    // incompatible with background:true (Azure background responses cannot
    // resume without server-side stored state). Reject before any shape
    // detection so the rule applies uniformly to messages, array input,
    // string input, and missing input. A later sanitizer would silently
    // flip store:true on a background job, defeating the opt-out — that
    // path is also hardened, but rejecting here is the source of truth.
    if (parsedBody?.store === false && parsedBody?.background === true) {
      diag("AZURE_STORE_BACKGROUND_CONFLICT", "store:false + background:true is incompatible");
      return jsonErrorResponse(
        400,
        "store:false is incompatible with background:true. Azure background responses require server-side stored state to resume. Send store:true to allow chaining, or drop background:true for a stateless one-shot.",
        "store_background_conflict",
        "invalid_request_error"
      );
    }

    const hasMessages = parsedBody?.messages && !parsedBody?.input;
    const hasInput = parsedBody?.input && Array.isArray(parsedBody.input);

    if (hasMessages || hasInput) {
      const azureScopeUser = await cacheScopeUserId(req);
      // Scope embeds three identifiers in addition to provider + version + user:
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
      // The cache version was bumped to v7 alongside this change so any
      // pre-existing v6 keys are orphaned cleanly across the deploy.
      const azureScopeDeployment = parsedBody?.model || "(none)";
      const azureScopeResource = (
        process.env.AZURE_OPENAI_ENDPOINT
        || process.env.AZURE_FOUNDRY_RESOURCE
        || "(none)"
      ).trim().toLowerCase().replace(/\/+$/, "");
      const azureScope = [
        providerKey,
        AZURE_OPENAI_RESPONSE_CACHE_VERSION,
        azureScopeResource,
        azureScopeDeployment,
        azureScopeUser,
      ].join(":");

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
      azureReplyKey = await conversationHash(hashItems, hashItems.length, azureScope);

      // Honour an explicit client opt-out before doing anything KV-related.
      // store:false means the client requires this turn to be stateless on
      // Azure's side (compliance / privacy-sensitive workloads). That implies
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
        diag("AZURE_STORE_OPT_OUT", "client sent store:false — chaining disabled (no prev lookup, no KV write)");
      }

      // Look up a cached response ID from the prior turn.
      // hashBoundaryIdx marks items BEFORE the contiguous assistant block.
      let prevRespId = null;
      if (!storeOptOut && hashBoundaryIdx >= 0) {
        const prevRespKey = await conversationHash(hashItems, hashBoundaryIdx, azureScope);
        const readResult = await waitForAzResponseId("azresp:" + prevRespKey);
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

        if (prevRespId) {
          // If trimming would produce an empty input, force stateless mode.
          // Azure rejects previous_response_id with no new items.
          if (parsedBody.messages.slice(lastAssistantIdx + 1).length === 0) {
            prevRespId = null;
            log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
                 "lastAssistantIdx:", lastAssistantIdx,
                 "totalItems:", parsedBody.messages.length);
          } else {
            // Only send input items that appeared AFTER the last assistant.
            // Azure replays the full prior conversation server-side.
            parsedBody.input = parsedBody.messages.slice(lastAssistantIdx + 1)
              .reduce((acc, item) => {
                acc.push(...normalizeAzureInput(item));
                return acc;
              }, []);
            parsedBody.previous_response_id = prevRespId;
          }
        }
        if (!prevRespId && !parsedBody.input) {
          // Stateless fallback — full input array (but response is still stored
          // so the NEXT turn can chain from it).
          parsedBody.input = parsedBody.messages.reduce((acc, item) => {
            acc.push(...normalizeAzureInput(item));
            return acc;
          }, []);
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
          if (parsedBody.input.slice(lastAssistantIdx + 1).length === 0) {
            prevRespId = null;
            log("INPUT_CHAIN_EMPTY_TRIM", "provider:", providerKey,
                 "lastAssistantIdx:", lastAssistantIdx,
                 "totalItems:", parsedBody.input.length);
          } else {
            parsedBody.input = parsedBody.input.slice(lastAssistantIdx + 1);
            parsedBody.previous_response_id = prevRespId;
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

  {
    const inputResult = normalizeAzureOpenAIInputContent(providerKey, parsedBody);
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
    const toolsResult = normalizeAzureOpenAITools(providerKey, parsedBody);
    parsedBody = toolsResult.parsedBody;
    if (toolsResult.changed) {
      bodyText = JSON.stringify(parsedBody);
    }
  }

  let azureModelName = upstreamModelName;

  {
    const openAiSanitized = sanitizeAzureOpenAIBody(providerKey, parsedBody, azureModelName, azureAliasInfo);
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
      `Unknown provider "${providerKey}". Use deepseek, kimi, minimax, mimo, glm, fireworks, azureopenai, or azureanthropic (or set model to a matching name, e.g. cursorproxy/claude-sonnet-4-6, claude-sonnet-4-6, cursorproxy/fireworks/kimi-k2p7-code, or cursorproxy/glm-5.2).`,
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

  // Fireworks-hosted GLM 5.2+ supports reasoning_effort (DeepSeek-V4 mechanism).
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
  const replyReasoningKey = originalMessages
    ? await conversationHash(originalMessages, originalMessages.length, scope)
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
      conversationHash,
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
  if (providerKey === "azureanthropic" && parsedBody?.messages && parsedBody?.thinking?.type && parsedBody?.thinking?.type !== "disabled") {
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
  const isAzureFoundryKimi = providerKey === "kimi" && isAzureFoundryKimiEndpoint(provider.url);
  const usesAzureHeaderIsolation = isAzureProvider || isAzureFoundryKimi;
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

  let upstreamRes;
  // Connect-phase timeout (cleared as soon as headers arrive — never aborts the
  // streaming body). Safe to apply on Docker too; default 15s, override via
  // UPSTREAM_CONNECT_TIMEOUT_MS (set to 0 to disable).
  const connectTimeoutMs = (() => {
    const raw = parseInt(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || "", 10);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 15000;
  })();
  const connectController = connectTimeoutMs > 0 ? new AbortController() : null;
  const connectTimer = connectController
    ? setTimeout(() => connectController.abort(), connectTimeoutMs)
    : null;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyText || null,
      ...(connectController ? { signal: connectController.signal } : {}),
    });
    if (connectTimer) clearTimeout(connectTimer);
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
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

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isStream = contentType.includes("text/event-stream");
  log("UPSTREAM_STATUS", upstreamRes.status, "provider:", providerKey, "stream:", isStream);

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
    if (providerKey === "azureanthropic") {
      if (parsedBody?.thinking?.type === "adaptive" && originalMessages) {
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
    if (providerKey === "azureopenai") {
      const azureRespId = json.id;
      // Mirror the stream-side cache guard: only persist response IDs for
      // turns that actually completed. A response with status=incomplete /
      // failed / cancelled cannot be replayed via previous_response_id —
      // caching it would 400 the next turn and burn a free retry.
      const azureRespStatus = json.status || "completed";
      json = mapResponsesToOpenAI(json);
      if (azureRespId && azureReplyKey) {
        if (azureRespStatus === "completed") {
          log("CACHE_AZ_RESP_ID", "key:", azureReplyKey, "id:", azureRespId);
          await kvSet("azresp:" + azureReplyKey, azureRespId);
        } else {
          log("SKIP_CACHE_AZ_RESP_ID", "key:", azureReplyKey, "id:", azureRespId, "status:", azureRespStatus);
        }
      }
    }

    json = withPublicResponseModel(json, responseModelName, Boolean(azureAliasInfo) || providerKey === "glm" || providerKey === "fireworks");

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

    // Track Claude thinking blocks for KV caching (azureanthropic + adaptive thinking).
    // Store the content_block object from content_block_start directly, then mutate
    // its fields as thinking_delta / signature_delta arrive.  This preserves the
    // exact shape including empty-string fields (e.g. thinking: "" for omitted
    // thinking) so the cached block round-trips unchanged.
    const claudeThinkBlocks = new Map(); // index -> content_block object
    const claudeThinkActive = providerKey === "azureanthropic" &&
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

    function countAzureEvent(eventName) {
      const key = eventName || "unknown";
      azureEventCounts.total++;
      azureEventCounts[key] = (azureEventCounts[key] || 0) + 1;
    }

    function logAzureStreamSummary(reason) {
      if (providerKey !== "azureopenai" || azureStreamSummaryLogged || azureEventCounts.total === 0) return;
      azureStreamSummaryLogged = true;
      diag("AZURE_STREAM_SUMMARY",
           "reason:", reason,
           "content:", accContent.length,
           "refusal:", accRefusal.length,
           "functionArgDeltas:", azureFunctionDeltaCount,
           "events:", JSON.stringify(azureEventCounts));
      if (accRefusal) {
        log("AZURE_REFUSAL_PREVIEW", accRefusal.slice(0, 240));
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
      if (azureResponseTerminalStatus && azureResponseTerminalStatus !== "completed") {
        azureRespCached = true;
        log("SKIP_CACHE_AZ_RESP_ID",
            "key:", azureReplyKey,
            "id:", azureResponseId,
            "status:", azureResponseTerminalStatus,
            "incomplete:", azureResponseIncompleteReason || "(none)");
        return;
      }
      azureRespCached = true;
      log("CACHE_AZ_RESP_ID", "key:", azureReplyKey, "id:", azureResponseId);
      await kvSet("azresp:" + azureReplyKey, azureResponseId)
        .catch((err) => log("CACHE_AZ_WRITE_ERROR", err?.message));
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
          // For Azure OpenAI (Responses API), track event: lines to use when
          // processing data: lines — the event name tells us what type of delta it is.
          if (providerKey === "azureopenai" && line.startsWith("event: ")) {
            currentResponsesEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            if (!(providerKey === "azureanthropic" || providerKey === "azureopenai")) {
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
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            let json = JSON.parse(data);

            // Transform Anthropic SSE events into OpenAI-compatible format.
            // Anthropic uses events like content_block_delta with delta.text_delta,
            // but the proxy and Cursor expect choices[0].delta.content.
            if (providerKey === "azureanthropic") {
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
            if (providerKey === "azureopenai" && (currentResponsesEvent || json?.type)) {
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

              const mapped = mapResponsesSSEToOpenAI(responsesEvent, json, responsesToolState);
              if (mapped) {
                json = mapped;
              } else {
                // Capture the response ID from the first SSE event so we can
                // write it to KV and enable previous_response_id chaining on
                // the next turn.
                if (responsesEvent === "response.created" && !azureResponseId) {
                  azureResponseId = json?.response?.id || null;
                  if (azureResponseId) {
                    log("STREAM_AZ_RESP_ID", "id:", azureResponseId);
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
                  await writer.write(encoder.encode("data: [DONE]\n\n"));
                }
                continue; // skip events that produce no output
              }
            }

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
            json = withPublicResponseModel(json, responseModelName, Boolean(azureAliasInfo) || providerKey === "glm" || providerKey === "fireworks");
            await writer.write(
              encoder.encode(
                "data: " + JSON.stringify(stripResponseChunk(json)) + "\n\n"
              )
            );
          } catch {
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
      if (providerKey === "azureanthropic" && anthropicEventCounts.total > 0) {
        log("ANTHROPIC_EVENTS", anthropicEventCounts);
      }
      logAzureStreamSummary(timedOut ? "timeout" : "finally");
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
