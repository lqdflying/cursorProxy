import { allowedEnvValue } from "./auth.js";
import { createLogger } from "./logger.js";

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

function sanitizeAzureOpenAIBody(providerKey, parsedBody, azureModelName, aliasInfo = null) {
  if (providerKey !== "azureopenai" || !parsedBody) {
    return { parsedBody, sanitized: false, isReasoningModel: false };
  }

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
  // the reasoning budget for Azure OpenAI reasoning models.
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
  const defaultReasoningEffort = aliasEffort || globalEffort;
  let reasoningEffortSource = "client";
  if (isReasoningModel && defaultReasoningEffort) {
    if (!parsedBody.reasoning || typeof parsedBody.reasoning !== "object" || Array.isArray(parsedBody.reasoning)) {
      parsedBody.reasoning = {};
    }
    if (parsedBody.reasoning.effort !== defaultReasoningEffort) {
      parsedBody.reasoning.effort = defaultReasoningEffort;
      sanitized = true;
    }
    reasoningEffortSource = aliasEffort ? "alias" : "global";
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
  if (parsedBody.background === true && parsedBody.store !== true) {
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
function normalizeAzureOpenAITools(providerKey, parsedBody) {
  if (providerKey !== "azureopenai" || !parsedBody?.tools) {
    return { parsedBody, changed: false };
  }

  let toolsFixed = false;

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
    filtered.push(tool);
  }

  if (toolsFixed) {
    parsedBody.tools = filtered;
    const nWithDesc = filtered.filter(t => !!t.description).length;
    const nWithoutDesc = filtered.filter(t => !t.description).length;
    diag("TOOLS_FIXED", "provider:", providerKey, "from:", "mixed", "to:", "openai_responses",
      "kept:", filtered.length, "dropped:", dropped, "native:", keptNative,
      "withDesc:", nWithDesc, "withoutDesc:", nWithoutDesc);
  }

  return { parsedBody, changed: toolsFixed };
}

// ─── Azure Responses API → OpenAI Chat Completions response mappers ─────────

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

  return {
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
}

function rememberResponsesToolState(toolState, state) {
  toolState.set(state.id, state);
  if (state.itemId) toolState.set(`item:${state.itemId}`, state);
  if (state.index != null) toolState.set(`index:${state.index}`, state);
  return state;
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

function mapResponsesToolDelta(state, idx, partial) {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: idx,
          id: state.id,
          type: "function",
          function: { name: state.name, arguments: partial },
        }],
      },
    }],
  };
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
      const idx = data.output_index ?? 0;
      const state = responsesToolStateForDelta(toolState, data);
      state.partialJson += partial;
      return mapResponsesToolDelta(state, idx, partial);
    }

    case "response.custom_tool_call_input.delta": {
      const partial = data.delta || "";
      const idx = data.output_index ?? 0;
      const state = responsesToolStateForDelta(toolState, data);
      state.partialJson += partial;
      return mapResponsesToolDelta(state, idx, partial);
    }

    case "response.apply_patch_call.delta":
    case "response.apply_patch_call_input.delta": {
      const partial = data.delta || "";
      const idx = data.output_index ?? 0;
      const state = responsesToolStateForDelta(toolState, data, "apply_patch");
      state.partialJson += partial;
      return mapResponsesToolDelta(state, idx, partial);
    }

    case "response.output_item.added": {
      const item = data.item;
      if (item?.type === "message" && item?.role === "assistant") {
        return { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] };
      }
      if (item?.type === "function_call") {
        const callId = item.call_id || "call_0";
        const idx = data.output_index ?? 0;
        rememberResponsesToolState(toolState, {
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
              tool_calls: [{ index: idx, id: callId, type: "function", function: { name: item.name || "", arguments: "" } }],
            },
          }],
        };
      }
      if (item?.type === "custom_tool_call" || item?.type === "apply_patch_call") {
        const idx = data.output_index ?? 0;
        const callId = item.call_id || item.id || `call_${idx}`;
        const name = item.type === "apply_patch_call" ? "apply_patch" : (item.name || "");
        rememberResponsesToolState(toolState, {
          id: callId,
          name,
          partialJson: "",
          index: idx,
          itemId: item.id || data.item_id || "",
        });
        return mapResponsesToolDelta({ id: callId, name }, idx, "");
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
  isAzureReasoningModel,
  mapResponsesSSEToOpenAI,
  mapResponsesToOpenAI,
  normalizeAzureOpenAIInputContent,
  normalizeAzureOpenAITools,
  sanitizeAzureOpenAIBody,
};
