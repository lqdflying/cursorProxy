import { allowedEnvValue, cleanEnvValue } from "./auth.js";
import {
  isCursorShellToolName,
  repairCursorCallMcpToolSchema,
  validateCursorShellArgs,
} from "./cursor-tools.js";
import { createLogger } from "./logger.js";
import { isOpenAICompatResponses } from "./models.js";
import {
  hasInvalidOpenAICompatReasoningEffortEnv,
  openAICompatReasoningEffortForModel,
} from "./openaicompat-cache.js";

const { diag } = createLogger("azure-openai");

const AZURE_OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const AZURE_OPENAI_RESPONSES_TOOL_TYPES = new Set([
  "custom",
  "web_search",
  "web_search_preview",
  "file_search",
  "computer_use_preview",
  "code_interpreter",
  "image_generation",
  "mcp",
  "apply_patch",
]);
const OPENAI_COMPAT_RESPONSES_CONTENT_METADATA_KEYS = [
  "providerOptions",
  "provider_options",
  "providerMetadata",
  "experimental_providerMetadata",
];

let openAICompatReasoningEffortInvalidLogged = false;

function openAICompatReasoningEffortEnv(model) {
  const effort = openAICompatReasoningEffortForModel(model);
  if (effort) return effort;
  if (hasInvalidOpenAICompatReasoningEffortEnv() && !openAICompatReasoningEffortInvalidLogged) {
    openAICompatReasoningEffortInvalidLogged = true;
    diag("OPENAICOMPAT_REASONING_EFFORT_INVALID",
      "raw:", cleanEnvValue("OPENAICOMPAT_REASONING_EFFORT"),
      "fallback:", "client",
      "valid:", "none|minimal|low|medium|high|xhigh|max");
  }
  return "";
}

function isAzureReasoningModel(providerKey, azureModelName) {
  return providerKey === "azureopenai"
    && /^(?:o\d(?:[-.]|$)|gpt-5(?:\.\d+)?(?:[-.]|$))/i.test(azureModelName || "");
}

function incrementCount(counts, key) {
  const normalized = key || "(none)";
  counts[normalized] = (counts[normalized] || 0) + 1;
}

function formatCounts(counts) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length
    ? entries.map(([key, count]) => `${key}:${count}`).join(",")
    : "(none)";
}

function isKnownResponsesToolType(type) {
  return typeof type === "string" && AZURE_OPENAI_RESPONSES_TOOL_TYPES.has(type);
}

function azureInputShape(input) {
  const shape = {
    roles: {},
    itemTypes: {},
    contentTypes: {},
    items: Array.isArray(input) ? input.length : 0,
  };

  if (!Array.isArray(input)) return shape;

  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      incrementCount(shape.itemTypes, typeof item);
      continue;
    }
    incrementCount(shape.roles, item.role);
    incrementCount(shape.itemTypes, item.type);

    const content = item.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          incrementCount(shape.contentTypes, part.type);
        } else {
          incrementCount(shape.contentTypes, typeof part);
        }
      }
    } else if (content != null) {
      incrementCount(shape.contentTypes, typeof content);
    }
  }

  return shape;
}

function logAzureInputShape(providerKey, parsedBody, stage) {
  if (providerKey !== "azureopenai" || !Array.isArray(parsedBody?.input)) return;

  const shape = azureInputShape(parsedBody.input);
  diag("AZURE_INPUT_SHAPE",
    "provider:", providerKey,
    "stage:", stage,
    "inputItems:", shape.items,
    "roles:", formatCounts(shape.roles),
    "itemTypes:", formatCounts(shape.itemTypes),
    "contentTypes:", formatCounts(shape.contentTypes));
}

function azureTextPartType(role) {
  const isAssistant = role === "assistant";
  return isAssistant ? "output_text" : "input_text";
}

function azureTextPart(text, role) {
  return { type: azureTextPartType(role), text };
}

function normalizeAzureContentPart(part, role) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;

  let changed = false;
  const inputTextType = azureTextPartType(role);
  const isAssistant = role === "assistant";

  if (!part.type && typeof part.text === "string") {
    part.type = inputTextType;
    changed = true;
  } else if (part.type === "text") {
    part.type = inputTextType;
    changed = true;
  } else if (isAssistant && part.type === "input_text") {
    part.type = "output_text";
    changed = true;
  } else if (!isAssistant && part.type === "output_text") {
    part.type = "input_text";
    changed = true;
  } else if (part.type === "image_url") {
    const imageUrl = typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url;
    part.type = "input_image";
    if (imageUrl) part.image_url = imageUrl;
    changed = true;
  }

  return changed;
}

function normalizeAzureMessageItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;

  let changed = false;
  const hasMessageShape = item.role && Object.prototype.hasOwnProperty.call(item, "content");
  if (!item.type && hasMessageShape) {
    item.type = "message";
    changed = true;
  }

  if (typeof item.content === "string") {
    item.content = [azureTextPart(item.content, item.role)];
    changed = true;
  } else if (item.content && typeof item.content === "object" && !Array.isArray(item.content)) {
    item.content = [item.content];
    changed = true;
  }

  if (Array.isArray(item.content)) {
    for (let i = 0; i < item.content.length; i++) {
      const part = item.content[i];
      if (typeof part === "string") {
        item.content[i] = azureTextPart(part, item.role);
        changed = true;
        continue;
      }
      if (normalizeAzureContentPart(part, item.role)) {
        changed = true;
      }
    }
  }

  return changed;
}

function azureContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object" || Array.isArray(part)) return "";
        return part.text ?? part.refusal ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content.text ?? content.refusal ?? "";
  }
  return "";
}

function promoteInstructionInputItems(parsedBody) {
  if (!Array.isArray(parsedBody?.input)) return false;

  let changed = false;
  const instructionTexts = [];
  const roleCounts = {};
  const remaining = [];

  for (const item of parsedBody.input) {
    if (item?.type === "message" && (item.role === "system" || item.role === "developer")) {
      const text = azureContentText(item.content).trim();
      if (text) {
        instructionTexts.push(text);
        incrementCount(roleCounts, item.role);
      }
      changed = true;
      continue;
    }
    remaining.push(item);
  }

  if (!changed) return false;

  parsedBody.input = remaining;
  if (instructionTexts.length > 0) {
    parsedBody.instructions = [parsedBody.instructions, ...instructionTexts]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n\n");
    diag("AZURE_INSTRUCTIONS_FROM_INPUT",
      "roles:", formatCounts(roleCounts),
      "chars:", instructionTexts.reduce((sum, text) => sum + text.length, 0));
  }

  return true;
}

function normalizeAzureOpenAIInputContent(providerKey, parsedBody) {
  if (providerKey !== "azureopenai" || !Array.isArray(parsedBody?.input)) {
    return { parsedBody, changed: false };
  }

  logAzureInputShape(providerKey, parsedBody, "before");

  let changed = false;
  for (const item of parsedBody.input) {
    if (normalizeAzureMessageItem(item)) {
      changed = true;
    }
  }
  if (promoteInstructionInputItems(parsedBody)) {
    changed = true;
  }

  if (changed) {
    logAzureInputShape(providerKey, parsedBody, "after");
    diag("AZURE_INPUT_NORMALIZED", "provider:", providerKey);
  }

  return { parsedBody, changed };
}

function normalizeOpenAICompatResponsesInputContent(providerKey, parsedBody) {
  if (!isOpenAICompatResponses(providerKey) || !Array.isArray(parsedBody?.input)) {
    return { parsedBody, changed: false };
  }

  let changed = false;
  let textPartsFixed = 0;
  let imagePartsFixed = 0;
  let providerOptionPartsFixed = 0;
  for (const item of parsedBody.input) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(item.content)) {
      continue;
    }

    const textType = item.role === "assistant" ? "output_text" : "input_text";
    for (let i = 0; i < item.content.length; i++) {
      const part = item.content[i];
      if (typeof part === "string") {
        item.content[i] = { type: textType, text: part };
        changed = true;
        textPartsFixed++;
        continue;
      }
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      let strippedProviderOptions = false;
      for (const key of OPENAI_COMPAT_RESPONSES_CONTENT_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(part, key)) {
          delete part[key];
          strippedProviderOptions = true;
        }
      }
      if (strippedProviderOptions) {
        changed = true;
        providerOptionPartsFixed++;
      }
      if (part.type === "text") {
        part.type = textType;
        changed = true;
        textPartsFixed++;
      } else if (!part.type && typeof part.text === "string") {
        part.type = textType;
        changed = true;
        textPartsFixed++;
      } else if (part.type === "image_url") {
        const imageUrl = typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url;
        part.type = "input_image";
        if (imageUrl) part.image_url = imageUrl;
        changed = true;
        imagePartsFixed++;
      }
    }
  }

  if (changed) {
    diag("OAI_INPUT_NORMALIZED",
      "provider:", providerKey,
      "textParts:", textPartsFixed,
      "imageParts:", imagePartsFixed,
      "providerOptionParts:", providerOptionPartsFixed);
  }

  return { parsedBody, changed };
}

function sanitizeAzureOpenAIBody(providerKey, parsedBody, azureModelName, aliasInfo = null) {
  if ((providerKey !== "azureopenai" && !isOpenAICompatResponses(providerKey)) || !parsedBody) {
    return { parsedBody, sanitized: false, isReasoningModel: false };
  }

  // For openaicompat-Responses, Azure-specific env overrides must never apply.
  // isAzureReasoningModel() returns false for non-azure providers, so reasoning-
  // model gating (sampling-param stripping + effort env injection) is inert.
  // Pass aliasInfo=null so no alias effort env is consulted.
  const isReasoningModel = isAzureReasoningModel(providerKey, azureModelName);
  let sanitized = false;

  // Responses API uses max_output_tokens. Accept legacy Chat Completions
  // token-limit fields from clients and map them before the whitelist runs.
  if ("max_tokens" in parsedBody && !("max_output_tokens" in parsedBody)) {
    parsedBody.max_output_tokens = parsedBody.max_tokens;
    delete parsedBody.max_tokens;
    sanitized = true;
  }
  if ("max_completion_tokens" in parsedBody && !("max_output_tokens" in parsedBody)) {
    parsedBody.max_output_tokens = parsedBody.max_completion_tokens;
    delete parsedBody.max_completion_tokens;
    sanitized = true;
  }
  if ("max_tokens" in parsedBody) {
    delete parsedBody.max_tokens;
    sanitized = true;
  }
  if ("max_completion_tokens" in parsedBody) {
    delete parsedBody.max_completion_tokens;
    sanitized = true;
  }

  // Reasoning models (all GPT-5.x and o-series) reject several standard chat params.
  // Per Microsoft docs: temperature, top_p, presence_penalty, frequency_penalty,
  // logprobs, top_logprobs, logit_bias, max_tokens are NOT supported.
  // Standard models (gpt-4o, gpt-4.1, …) accept all of these — preserve them.
  if (isReasoningModel) {
    const reasoningUnsupported = [
      "temperature", "top_p", "presence_penalty", "frequency_penalty",
      "logprobs", "top_logprobs", "logit_bias",
    ];
    for (const key of reasoningUnsupported) {
      if (key in parsedBody) {
        delete parsedBody[key];
        sanitized = true;
      }
    }
  }

  // Responses API uses nested reasoning.effort, not flat reasoning_effort.
  // Map flat reasoning_effort (from Cursor or legacy requests) to nested format.
  if ("reasoning_effort" in parsedBody) {
    if (!parsedBody.reasoning || typeof parsedBody.reasoning !== "object" || Array.isArray(parsedBody.reasoning)) {
      parsedBody.reasoning = {};
    }
    if (!parsedBody.reasoning.effort) {
      parsedBody.reasoning.effort = parsedBody.reasoning_effort;
    }
    delete parsedBody.reasoning_effort;
    sanitized = true;
  }

  // Env wins over Cursor/client effort so deployments can centrally force
  // the reasoning budget for Azure OpenAI reasoning models and openaicompat
  // Responses mode independently. Azure envs must never leak into
  // openaicompat, and the openaicompat env must never affect Azure.
  //
  // Precedence (highest to lowest):
  //   1. Alias-specific effort env (e.g. AZURE_OPENAI_GENERAL_REASONING_EFFORT)
  //      — only when the request routes through that alias.
  //   2. Global AZURE_OPENAI_REASONING_EFFORT.
  //   3. Whatever the client/Cursor sent (kept as-is from the flat→nested
  //      remap above).
  const aliasEffort = aliasInfo?.effortEnv
    ? allowedEnvValue(aliasInfo.effortEnv, AZURE_OPENAI_REASONING_EFFORTS)
    : null;
  const globalEffort = allowedEnvValue("AZURE_OPENAI_REASONING_EFFORT", AZURE_OPENAI_REASONING_EFFORTS);
  const openAICompatEffort = isOpenAICompatResponses(providerKey)
    ? openAICompatReasoningEffortEnv(azureModelName || parsedBody?.model)
    : null;
  const defaultReasoningEffort = openAICompatEffort || (providerKey === "azureopenai" ? aliasEffort || globalEffort : null);
  let reasoningEffortSource = "client";
  if ((isReasoningModel || openAICompatEffort) && defaultReasoningEffort) {
    if (!parsedBody.reasoning || typeof parsedBody.reasoning !== "object" || Array.isArray(parsedBody.reasoning)) {
      parsedBody.reasoning = {};
    }
    if (parsedBody.reasoning.effort !== defaultReasoningEffort) {
      parsedBody.reasoning.effort = defaultReasoningEffort;
      sanitized = true;
    }
    reasoningEffortSource = openAICompatEffort ? "openaicompat_env" : aliasEffort ? "alias" : "global";
  }

  if (parsedBody.reasoning?.effort) {
    diag("REASONING_EFFORT",
      "effort:", parsedBody.reasoning.effort,
      "provider:", providerKey,
      "source:", reasoningEffortSource,
      "alias:", aliasInfo?.aliasName || "(none)");
  }

  // PROBE: detect system field present without instructions
  if ("system" in parsedBody && typeof parsedBody.system === "string") {
    if (!("instructions" in parsedBody)) {
      diag("SYSTEM_WITHOUT_INSTRUCTIONS", "provider:", providerKey, "systemLen:", parsedBody.system.length);
      parsedBody.instructions = parsedBody.system;
      sanitized = true;
    } else {
      diag("SYSTEM_AND_INSTRUCTIONS", "provider:", providerKey);
    }
    delete parsedBody.system;
    sanitized = true;
  }

  // Known valid OpenAI Responses API params.
  // Responses API uses a different parameter set than Chat Completions.
  const allowed = new Set([
    "model", "input", "instructions", "prompt", "stream",
    "max_output_tokens", "temperature", "top_p",
    "tools", "tool_choice", "reasoning",
    "store", "parallel_tool_calls", "user",
    "previous_response_id", "include", "background",
    "truncation", "metadata", "prompt_cache_key",
    "prompt_cache_retention", "safety_identifier",
    "service_tier", "text",
  ]);

  // Strip any field not in the allowed whitelist
  for (const key of Object.keys(parsedBody)) {
    if (!allowed.has(key)) {
      delete parsedBody[key];
      sanitized = true;
    }
  }

  // Background Responses require stored state so the response can be resumed.
  // We never silently flip an explicit store:false to true here — that case
  // is rejected as a 400 in proxy.js (AZURE_STORE_BACKGROUND_CONFLICT) before
  // the sanitizer runs, so the only path that reaches us with both fields is
  // background:true + store omitted, which is safe to upgrade.
  if (parsedBody.background === true && parsedBody.store !== true && parsedBody.store !== false) {
    parsedBody.store = true;
    sanitized = true;
  }

  // Responses API: set store=false to prevent state leakage across users
  // and avoid Azure storage costs. Only inject when not explicitly set.
  if (!("store" in parsedBody)) {
    parsedBody.store = false;
    sanitized = true;
  }

  if (sanitized) {
    diag("AZURE_BODY_SANITIZED", "provider:", providerKey, "reasoning_model:", isReasoningModel);
  }

  return { parsedBody, sanitized, isReasoningModel };
}

// Normalize Anthropic-style tool definitions to OpenAI Responses API format.
// Responses API uses internally-tagged format: { type, name, description, parameters }
// unlike Chat Completions which wraps them in a "function" object.
function normalizeAzureOpenAITools(providerKey, parsedBody, options = {}) {
  if ((providerKey !== "azureopenai" && !isOpenAICompatResponses(providerKey)) || !parsedBody?.tools) {
    return { parsedBody, changed: false };
  }

  let toolsFixed = false;
  let callMcpToolSchemasFixed = 0;
  const repairCallMcpToolSchema = Boolean(options.repairCallMcpToolSchema);

  // PROBE: raw tool shape before conversion — what format did Cursor actually send?
  {
    const nTools = parsedBody.tools.length;
    const nAnthropicFmt = parsedBody.tools.filter(t => t.name && !t.function).length;
    const nChatCmplFmt = parsedBody.tools.filter(t => t.type === "function" && t.function).length;
    const nNativeToolType = parsedBody.tools.filter(t => t.type === "tool").length;
    const nKnownType = parsedBody.tools.filter(t => isKnownResponsesToolType(t?.type)).length;
    const nCustomApplyPatch = parsedBody.tools.filter(t => t?.type === "custom" && t?.name === "apply_patch").length;
    const nNativeApplyPatch = parsedBody.tools.filter(t => t?.type === "apply_patch").length;
    const nFunctionApplyPatch = parsedBody.tools.filter(t =>
      (t?.type === "function" && t?.function?.name === "apply_patch") ||
      (t?.type === "function" && t?.name === "apply_patch") ||
      (t?.name === "apply_patch" && !t?.function && t?.type !== "custom")
    ).length;
    diag("TOOLS_SHAPE", "provider:", providerKey, "total:", nTools,
      "anthropicFmt:", nAnthropicFmt, "chatCmplFmt:", nChatCmplFmt,
      "nativeToolType:", nNativeToolType, "knownType:", nKnownType);
    if (nCustomApplyPatch > 0 || nNativeApplyPatch > 0 || nFunctionApplyPatch > 0) {
      diag("APPLY_PATCH_TOOL_SHAPE", "provider:", providerKey,
        "custom:", nCustomApplyPatch,
        "native:", nNativeApplyPatch,
        "function:", nFunctionApplyPatch);
    }
    if (parsedBody.tool_choice) {
      diag("TOOL_CHOICE_SHAPE", "provider:", providerKey, "value:", JSON.stringify(parsedBody.tool_choice).slice(0, 200));
    }
  }

  // Normalize tool_choice to OpenAI Responses format.
  // Anthropic: { type:"any" }, { type:"tool", name:"x" }, { type:"auto" }, { type:"none" }
  // Chat Completions: { type:"function", function:{ name:"x" } }
  // Responses: "required", { type:"function", name:"x" }, "none", or absent (auto default)
  if (parsedBody.tool_choice && typeof parsedBody.tool_choice === "object") {
    const tc = parsedBody.tool_choice;
    if (tc.type === "any") {
      parsedBody.tool_choice = "required";
      toolsFixed = true;
    } else if (tc.type === "tool" && tc.name) {
      parsedBody.tool_choice = { type: "function", name: tc.name };
      toolsFixed = true;
    } else if (tc.type === "auto") {
      delete parsedBody.tool_choice;
      toolsFixed = true;
    } else if (tc.type === "none") {
      parsedBody.tool_choice = "none";
      toolsFixed = true;
    } else if (tc.type === "function" && tc.function?.name) {
      // Chat Completions forced-tool shape: unwrap to Responses {type:"function", name}
      parsedBody.tool_choice = { type: "function", name: tc.function.name };
      toolsFixed = true;
    }
  }

  const filtered = [];
  let dropped = 0;
  let keptNative = 0;
  for (const tool of parsedBody.tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      toolsFixed = true;
      dropped++;
      continue;
    }

    // Step 1: Preserve native Responses tools such as custom/apply_patch/mcp.
    // Cursor's Codex-style apply_patch arrives as {type:"custom", name, format}
    // and Azure streams it back as custom_tool_call_input deltas.
    if (isKnownResponsesToolType(tool.type)) {
      filtered.push(tool);
      keptNative++;
      continue;
    }

    // Step 2: Convert Anthropic-format tools (named, no wrapper) → Responses {type:"function", ...}
    // Must run BEFORE the type filter so versioned types like bash_20250124 are converted first.
    if (tool.name && !tool.function) {
      tool.type = "function";
      tool.parameters = tool.parameters || tool.input_schema || {};
      // description is valid in Responses API — preserve it for tool selection
      delete tool.input_schema;
      toolsFixed = true;
    }
    // Step 3: Unwrap Chat Completions format { type:"function", function:{...} } → inline
    else if (tool.type === "function" && tool.function) {
      tool.name = tool.function.name || "";
      tool.description = tool.function.description || "";
      tool.parameters = tool.function.parameters || {};
      delete tool.function;
      toolsFixed = true;
    }
    // Step 4: Drop non-function types that could not be converted.
    if (tool.type && tool.type !== "function") {
      toolsFixed = true;
      dropped++;
      continue;
    }
    if (repairCallMcpToolSchema) {
      const repair = repairCursorCallMcpToolSchema(tool);
      if (repair.changed) {
        toolsFixed = true;
        callMcpToolSchemasFixed++;
      }
    }
    filtered.push(tool);
  }

  if (toolsFixed) {
    parsedBody.tools = filtered;
    const nWithDesc = filtered.filter(t => !!t.description).length;
    const nWithoutDesc = filtered.filter(t => !t.description).length;
    diag("TOOLS_FIXED", "provider:", providerKey, "from:", "mixed", "to:", "openai_responses",
      "kept:", filtered.length, "dropped:", dropped, "native:", keptNative,
      "withDesc:", nWithDesc, "withoutDesc:", nWithoutDesc);
    if (callMcpToolSchemasFixed > 0) {
      diag("OAI_CALL_MCP_TOOL_SCHEMA_FIXED",
        "provider:", providerKey,
        "count:", callMcpToolSchemasFixed);
    }
  }

  return { parsedBody, changed: toolsFixed };
}

function isOpenAICompatFallbackDroppedTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  return tool.type === "custom" || tool.type === "apply_patch";
}

function openAICompatResponsesToolFallback(providerKey, parsedBody) {
  if (!isOpenAICompatResponses(providerKey) || !Array.isArray(parsedBody?.tools)) {
    return { parsedBody, changed: false, droppedNative: 0, functionTools: 0 };
  }

  const functionTools = parsedBody.tools.filter(t => t?.type === "function").length;
  const droppableNative = parsedBody.tools.filter(t => isOpenAICompatFallbackDroppedTool(t)).length;
  if (functionTools === 0 || droppableNative === 0) {
    return { parsedBody, changed: false, droppedNative: 0, functionTools };
  }

  const fallbackBody = structuredClone(parsedBody);
  const droppedNames = new Set();
  fallbackBody.tools = fallbackBody.tools.filter((tool) => {
    if (isOpenAICompatFallbackDroppedTool(tool)) {
      if (tool.name) droppedNames.add(tool.name);
      if (tool.type === "apply_patch") droppedNames.add("apply_patch");
      return false;
    }
    return true;
  });

  const toolChoiceName = fallbackBody.tool_choice?.name || fallbackBody.tool_choice?.function?.name || "";
  if (toolChoiceName && droppedNames.has(toolChoiceName)) {
    delete fallbackBody.tool_choice;
  }

  const droppedNative = parsedBody.tools.length - fallbackBody.tools.length;
  return { parsedBody: fallbackBody, changed: droppedNative > 0, droppedNative, functionTools };
}

// ─── Azure Responses API → OpenAI Chat Completions response mappers ─────────

function mapResponsesUsageToOpenAI(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
  const mapped = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details;
  if (inputDetails && typeof inputDetails === "object") {
    const promptDetails = {};
    if (inputDetails.cached_tokens != null) promptDetails.cached_tokens = inputDetails.cached_tokens;
    if (inputDetails.audio_tokens != null) promptDetails.audio_tokens = inputDetails.audio_tokens;
    if (inputDetails.image_tokens != null) promptDetails.image_tokens = inputDetails.image_tokens;
    if (Object.keys(promptDetails).length > 0) {
      mapped.prompt_tokens_details = promptDetails;
    }
  }
  return mapped;
}

function mapResponsesToOpenAI(json) {
  if (!json || !json.output || !Array.isArray(json.output)) return json;

  let textContent = "";
  const toolCalls = [];

  for (const item of json.output) {
    if (item.type === "message" && item.role === "assistant") {
      if (Array.isArray(item.content)) {
        textContent = item.content
          .filter((c) => c.type === "output_text" || c.type === "refusal")
          .map((c) => c.text ?? c.refusal ?? "")
          .join("");
      } else if (typeof item.content === "string") {
        textContent = item.content;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || "",
        type: "function",
        function: {
          name: item.name || "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
    } else if (item.type === "custom_tool_call") {
      toolCalls.push({
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: item.name || "",
          arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input || ""),
        },
      });
    } else if (item.type === "apply_patch_call") {
      toolCalls.push({
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: "apply_patch",
          arguments: typeof item.input === "string"
            ? item.input
            : typeof item.patch === "string"
              ? item.patch
              : JSON.stringify(item.input || item.patch || ""),
        },
      });
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const mapped = {
    id: json.id || "resp_unknown",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: json.model || "",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
  };
  const usage = mapResponsesUsageToOpenAI(json.usage);
  if (usage) mapped.usage = usage;
  return mapped;
}

function invalidOpenAICompatResponsesShellCall(json) {
  if (!Array.isArray(json?.output)) return null;

  for (let outputIndex = 0; outputIndex < json.output.length; outputIndex++) {
    const item = json.output[outputIndex];
    if (item?.type !== "function_call" || !isCursorShellToolName(item.name)) {
      continue;
    }

    const argsText = typeof item.arguments === "string"
      ? item.arguments
      : JSON.stringify(item.arguments || {});
    const validation = validateCursorShellArgs(argsText);
    if (!validation.valid) {
      return {
        argsText,
        outputIndex,
        reason: validation.reason,
      };
    }
  }

  return null;
}

const RESPONSES_NEXT_TOOL_INDEX = "__nextToolIndex";

function allocateResponsesToolIndex(toolState) {
  const next = toolState.get(RESPONSES_NEXT_TOOL_INDEX) || 0;
  toolState.set(RESPONSES_NEXT_TOOL_INDEX, next + 1);
  return next;
}

function rememberResponsesToolState(toolState, state) {
  const existing =
    (state.id && toolState.get(state.id)) ||
    (state.itemId && toolState.get(`item:${state.itemId}`)) ||
    (state.index != null && toolState.get(`index:${state.index}`));

  const target = existing || {
    ...state,
    finalArgsReceived: false,
    finalArgsValid: false,
    toolIndex: state.toolIndex ?? allocateResponsesToolIndex(toolState),
  };
  if (state.id && (!target.id || target.id.startsWith("call_"))) target.id = state.id;
  if (state.name && !target.name) target.name = state.name;
  if (state.itemId && !target.itemId) target.itemId = state.itemId;
  if (state.index != null && target.index == null) target.index = state.index;
  if (target.toolIndex == null) target.toolIndex = allocateResponsesToolIndex(toolState);

  toolState.set(target.id, target);
  if (target.itemId) toolState.set(`item:${target.itemId}`, target);
  if (target.index != null) toolState.set(`index:${target.index}`, target);
  return target;
}

function responsesToolStateForDelta(toolState, data, defaultName = "") {
  const idx = data.output_index ?? 0;
  const existing =
    (data.call_id && toolState.get(data.call_id)) ||
    (data.item_id && toolState.get(`item:${data.item_id}`)) ||
    toolState.get(`index:${idx}`);
  if (existing) return existing;

  const id = data.call_id || data.item_id || `call_${idx}`;
  return rememberResponsesToolState(toolState, {
    id,
    name: data.name || defaultName,
    partialJson: "",
    index: idx,
    itemId: data.item_id || "",
  });
}

function mapResponsesToolDelta(state, partial) {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: state.toolIndex ?? 0,
          id: state.id,
          type: "function",
          function: { name: state.name, arguments: partial },
        }],
      },
    }],
  };
}

function finalizeResponsesToolState(
  state,
  eventName,
  argsText,
  { validateFinalArgs } = {},
) {
  if (!state) return null;
  state.finalArgsReceived = true;
  state.finalArgsInvalidReason = null;
  if (eventName === "response.function_call_arguments.done") {
    if (typeof validateFinalArgs === "function") {
      const validation = validateFinalArgs(argsText);
      state.finalArgsValid = validation?.valid === true;
      state.finalArgsInvalidReason = state.finalArgsValid
        ? null
        : validation?.reason || "invalid_arguments";
    } else {
      try {
        JSON.parse(argsText);
        state.finalArgsValid = true;
      } catch {
        state.finalArgsValid = false;
        state.finalArgsInvalidReason = "invalid_json";
      }
    }
  } else {
    state.finalArgsValid = typeof argsText === "string";
    if (!state.finalArgsValid) {
      state.finalArgsInvalidReason = "invalid_arguments_type";
    }
  }
  return state;
}

function mapResponsesSSEToOpenAI(eventName, data, toolState) {
  if (!data) return null;

  switch (eventName) {
    case "response.output_text.delta": {
      const text = data.delta || "";
      return { choices: [{ index: 0, delta: { content: text } }] };
    }

    case "response.refusal.delta": {
      const text = data.delta || "";
      return { choices: [{ index: 0, delta: { refusal: text } }] };
    }

    case "response.function_call_arguments.delta": {
      const partial = data.delta || "";
      const state = responsesToolStateForDelta(toolState, data);
      state.partialJson += partial;
      return mapResponsesToolDelta(state, partial);
    }

    case "response.custom_tool_call_input.delta": {
      const partial = data.delta || "";
      const state = responsesToolStateForDelta(toolState, data);
      state.partialJson += partial;
      return mapResponsesToolDelta(state, partial);
    }

    case "response.apply_patch_call.delta":
    case "response.apply_patch_call_input.delta": {
      const partial = data.delta || "";
      const state = responsesToolStateForDelta(toolState, data, "apply_patch");
      state.partialJson += partial;
      return mapResponsesToolDelta(state, partial);
    }

    case "response.output_item.added": {
      const item = data.item;
      if (item?.type === "message" && item?.role === "assistant") {
        return { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] };
      }
      if (item?.type === "function_call") {
        const callId = item.call_id || "call_0";
        const idx = data.output_index ?? 0;
        const state = rememberResponsesToolState(toolState, {
          id: callId,
          name: item.name || "",
          partialJson: "",
          index: idx,
          itemId: item.id || data.item_id || "",
        });
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: state.toolIndex, id: callId, type: "function", function: { name: item.name || "", arguments: "" } }],
            },
          }],
        };
      }
      if (item?.type === "custom_tool_call" || item?.type === "apply_patch_call") {
        const idx = data.output_index ?? 0;
        const callId = item.call_id || item.id || `call_${idx}`;
        const name = item.type === "apply_patch_call" ? "apply_patch" : (item.name || "");
        const state = rememberResponsesToolState(toolState, {
          id: callId,
          name,
          partialJson: "",
          index: idx,
          itemId: item.id || data.item_id || "",
        });
        return mapResponsesToolDelta(state, "");
      }
      return null;
    }

    case "response.function_call_arguments.done":
    case "response.custom_tool_call_input.done":
    case "response.apply_patch_call.done":
    case "response.apply_patch_call_input.done": {
      return null;
    }

    default:
      return null;
  }
}

// ─── End Azure Responses API mappers ────────────────────────────────────────

export {
  finalizeResponsesToolState,
  invalidOpenAICompatResponsesShellCall,
  isAzureReasoningModel,
  mapResponsesSSEToOpenAI,
  mapResponsesToOpenAI,
  mapResponsesUsageToOpenAI,
  normalizeAzureOpenAIInputContent,
  normalizeOpenAICompatResponsesInputContent,
  normalizeAzureOpenAITools,
  openAICompatResponsesToolFallback,
  sanitizeAzureOpenAIBody,
};
