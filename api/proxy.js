export const config = { runtime: "edge" };

import { kvSet } from "../lib/kv.js";
import {
  mapAnthropicResponseToOpenAI,
  normalizeAnthropicContentTypes,
  remapAnthropicInput,
  sanitizeAzureAnthropicBody,
} from "../lib/azure-anthropic.js";
import {
  mapResponsesToOpenAI,
  normalizeAzureOpenAIInputContent,
  normalizeOpenAICompatResponsesInputContent,
  normalizeAzureOpenAITools,
  openAICompatResponsesToolFallback,
  sanitizeAzureOpenAIBody,
} from "../lib/azure-openai.js";
import { checkProxyAuth, cleanEnvValue, jsonErrorResponse } from "../lib/auth.js";
import { cacheScopeUserId, conversationHash, normalizedConversationHash, sha256ImageHash } from "../lib/cache.js";
import {
  deriveOpenAICompatChatRemotePromptCacheKey,
  deriveOpenAICompatChatRemoteSessionHeader,
  deriveOpenAICompatResponsesHaloPromptCacheKey,
  hasInvalidOpenAICompatCacheHitModeEnv,
  hasInvalidOpenAICompatReasoningEffortEnv,
  isOpenAICompatChatCacheFacadeMode,
  isOpenAICompatChatCacheRemoteMode,
  isOpenAICompatHaloCompatibleCacheMode,
  isOpenAICompatHaloCacheMode,
  isOpenAICompatSub2ApiCacheMode,
  openAICompatCacheHitModeValidValues,
  openaicompatConversationHash,
  normalizeOpenAICompatChatCacheUsage,
  openAICompatReasoningEffortEnv,
  openAICompatReasoningEffortForModel,
} from "../lib/openaicompat-cache.js";
import {
  isModelDiscoveryRequest,
  isOpenAICompatResponses,
  modelDiscoveryResponse,
  normalizeParsedBodyModel,
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
} from "../lib/reasoning.js";
import { sanitizeGlmBody } from "../lib/glm.js";
import { resolveFireworksGlmReasoningEffort } from "../lib/fireworks.js";
import { sanitizeKimiBody } from "../lib/kimi.js";
import { convertImagesToText, requiresVisionBridge } from "../lib/vision-bridge.js";
import {
  safeLogToken,
  summarizeToolChoiceForLog,
} from "../lib/log-shapes.js";
import { probeStrictTools, strictToolStats } from "../lib/strict-tools.js";
import {
  PROVIDERS,
  isAzureFoundryKimiEndpoint,
  isUnsafeUpstreamPath,
  upstreamApiKey,
} from "../lib/providers.js";
import { prepareResponsesChain, retryPreviousResponseFailure } from "../lib/responses-chain.js";
import { startStreamPump } from "../lib/stream-pump.js";

// Re-export for direct unit testing (test/proxy-strict-probe.test.js).
export { strictToolStats };

const DEBUG = process.env.DEBUG === "true";
let proxyAuthWarningLogged = false;
let openAICompatChatReasoningEffortInvalidLogged = false;

function log(...args) {
  if (process.env.DEBUG === "true") console.log("[cursorProxy:proxy]", ...args);
}

function diag(...args) {
  console.log("[cursorProxy:proxy]", ...args);
}

// Confirm at cold start that the opt-in cache flag was honored.
if (process.env.ANTHROPICCOMPAT_THINKING_CACHE === "true") {
  diag("COMPATIBLE_CACHE", "env:", "ANTHROPICCOMPAT_THINKING_CACHE", "enabled:", true);
}

export default async function handler(req) {
  const t0 = Date.now();
  let azureReplyKey = null; // KV key for saving response ID (azure or openaicompat)
  let respIdPreviousKvKey = null; // full KV key for stale previous_response_id cleanup
  let respIdCachePrefix = "azresp:"; // KV namespace prefix (set in chaining block)
  let respIdChainScope = null;
  let openAICompatStatelessRetryInput = null;
  let openAICompatChatRemoteSession = null;
  let openAICompatResponsesHaloCompatibleSession = null;
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
  const openAICompatResponsesHaloCompatibleCache = openaiCompatResponses
    && isOpenAICompatHaloCompatibleCacheMode();
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
  // to upstream model names (e.g. compatible-gpt-5.6 -> gpt-5.6-sol).
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
    const chatReasoningEffort = openAICompatReasoningEffortForModel(
      upstreamModelName || parsedBody.model,
      openAICompatReasoningEffortEnv()
    );
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
           "valid:", "none|minimal|low|medium|high|xhigh|max");
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

  if (openAICompatResponsesHaloCompatibleCache && parsedBody) {
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
      openAICompatResponsesHaloCompatibleSession = await deriveOpenAICompatChatRemoteSessionHeader(req, haloPromptCache);
      if (openAICompatResponsesHaloCompatibleSession.value) {
        diag("OAI_RESP_HALO_SESSION",
             "provider:", providerKey,
             "source:", openAICompatResponsesHaloCompatibleSession.source,
             "hash:", openAICompatResponsesHaloCompatibleSession.hash || "(none)");
      }
    }
  }

  // previous_response_id chaining via KV — azureopenai (always) and
  // openaicompat in Responses wire mode. See lib/responses-chain.js for the
  // full input-shape handling (messages vs native input) and scope design.
  if (providerKey === "azureopenai" || openaiCompatResponses) {
    const chain = await prepareResponsesChain({
      req,
      parsedBody,
      providerKey,
      upstreamModelName,
      openaiCompatResponses,
      openAICompatSub2ApiCache,
      openAICompatResponsesHaloCompatibleCache,
    });
    if (chain.errorResponse) return chain.errorResponse;
    if (chain.changed) bodyText = JSON.stringify(parsedBody);
    azureReplyKey = chain.replyKey;
    respIdPreviousKvKey = chain.previousKvKey;
    respIdCachePrefix = chain.cachePrefix;
    respIdChainScope = chain.chainScope;
    openAICompatStatelessRetryInput = chain.statelessRetryInput;
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
      ? normalizeAzureOpenAITools(providerKey, parsedBody, {
        repairCallMcpToolSchema: openAICompatResponsesHaloCache,
      })
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
      `Unknown provider "${providerKey}". Use deepseek, kimi, minimax, mimo, glm, fireworks, azureopenai, azureanthropic, openaicompat, or anthropiccompat (or set model to a matching name, e.g. cursorproxy/claude-sonnet-4-6, cursorproxy/compatible-gpt-5.6, or cursorproxy/fireworks/kimi-k2p7-code).`,
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
  if (openAICompatResponsesHaloCompatibleCache && openAICompatResponsesHaloCompatibleSession?.value) {
    headers.set("Session_id", openAICompatResponsesHaloCompatibleSession.value);
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

  // Stateless retry for gateways that reject or lose previous_response_id
  // state (see lib/responses-chain.js). Assemble downstream stream state from
  // the retried response when it ran.
  {
    const retry = await retryPreviousResponseFailure({
      upstreamRes,
      parsedBody,
      providerKey,
      openaiCompatResponses,
      openAICompatSub2ApiCache,
      statelessRetryInput: openAICompatStatelessRetryInput,
      chainScope: respIdChainScope,
      previousKvKey: respIdPreviousKvKey,
      fetchUpstream,
      connectTimeoutMs,
    });
    if (retry.errorResponse) return retry.errorResponse;
    if (retry.handled) {
      upstreamRes = retry.upstreamRes;
      parsedBody = retry.parsedBody;
      bodyText = retry.bodyText;
      contentType = retry.contentType;
      isStream = retry.isStream;
      if (retry.clearReplyKey) azureReplyKey = null;
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

  return startStreamPump({
    upstreamRes,
    contentType,
    t0,
    providerKey,
    openaiCompatResponses,
    openAICompatSub2ApiCache,
    openAICompatResponsesHaloCompatibleCache,
    openAICompatResponsesHaloCache,
    openAICompatChatCacheUsageFacade,
    responsesStreamIncludeUsage,
    upstreamModelName,
    responseModelName,
    azureAliasApplied: Boolean(azureAliasInfo),
    compatAliasApplied: Boolean(compatAliasInfo),
    parsedBody,
    originalMessages,
    scope,
    replyReasoningKey,
    azureReplyKey,
    respIdCachePrefix,
  });
}
