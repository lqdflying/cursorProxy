import { allowedEnvValue } from "./auth.js";
import { createLogger } from "./logger.js";

const { diag } = createLogger("azure-openai");

const AZURE_OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const AZURE_OPENAI_RESPONSE_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.cancelled",
]);

const AZURE_OPENAI_RESPONSE_TOOL_TYPES = new Set([
  "function",
  "file_search",
  "computer_use_preview",
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "mcp",
  "code_interpreter",
  "image_generation",
  "local_shell",
  "shell",
  "apply_patch",
]);

function isKnownResponsesToolType(type) {
  return AZURE_OPENAI_RESPONSE_TOOL_TYPES.has(type);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function defaultCustomToolParameters() {
  return {
    type: "object",
    properties: {
      input: { type: "string" },
    },
    required: ["input"],
  };
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

function sanitizeAzureOpenAIBody(providerKey, parsedBody, azureModelName) {
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
  const defaultReasoningEffort = allowedEnvValue("AZURE_OPENAI_REASONING_EFFORT", AZURE_OPENAI_REASONING_EFFORTS);
  if (isReasoningModel && defaultReasoningEffort) {
    if (!parsedBody.reasoning || typeof parsedBody.reasoning !== "object" || Array.isArray(parsedBody.reasoning)) {
      parsedBody.reasoning = {};
    }
    if (parsedBody.reasoning.effort !== defaultReasoningEffort) {
      parsedBody.reasoning.effort = defaultReasoningEffort;
      sanitized = true;
    }
  }

  if (parsedBody.reasoning?.effort) {
    diag("REASONING_EFFORT", "effort:", parsedBody.reasoning.effort, "provider:", providerKey);
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
    "model", "input", "instructions", "stream",
    "background", "include",
    "max_output_tokens", "temperature", "top_p",
    "metadata", "prompt", "prompt_cache_key", "prompt_cache_retention", "safety_identifier",
    "service_tier", "text", "top_logprobs", "truncation",
    "tools", "tool_choice", "reasoning",
    "store", "parallel_tool_calls", "user",
    "previous_response_id",
  ]);

  // Strip any field not in the allowed whitelist
  for (const key of Object.keys(parsedBody)) {
    if (!allowed.has(key)) {
      delete parsedBody[key];
      sanitized = true;
    }
  }

  // Responses API: set store=false to prevent state leakage across users
  // and avoid Azure storage costs. Background mode is stateful by definition
  // and Azure rejects background requests unless store=true.
  if (parsedBody.background === true && parsedBody.store !== true) {
    parsedBody.store = true;
    sanitized = true;
    diag("AZURE_BACKGROUND_STORE_FORCED", "provider:", providerKey);
  } else if (!("store" in parsedBody)) {
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

  if (!Array.isArray(parsedBody.tools)) {
    diag("TOOLS_INVALID", "provider:", providerKey, "shape:", typeof parsedBody.tools);
    delete parsedBody.tools;
    return { parsedBody, changed: true };
  }

  // PROBE: raw tool shape before conversion — what format did Cursor actually send?
  {
    const nTools = parsedBody.tools.length;
    const nInvalid = parsedBody.tools.filter(t => !isPlainObject(t)).length;
    const nAnthropicFmt = parsedBody.tools.filter(t =>
      isPlainObject(t) &&
      t.name &&
      !t.function &&
      (!t.type || (t.input_schema && !isKnownResponsesToolType(t.type)))
    ).length;
    const nChatCmplFmt = parsedBody.tools.filter(t => isPlainObject(t) && t.type === "function" && isPlainObject(t.function)).length;
    const nNativeToolType = parsedBody.tools.filter(t => isPlainObject(t) && typeof t.type === "string" && t.type !== "function").length;
    const nKnownNativeType = parsedBody.tools.filter(t => isPlainObject(t) && AZURE_OPENAI_RESPONSE_TOOL_TYPES.has(t.type)).length;
    diag("TOOLS_SHAPE", "provider:", providerKey, "total:", nTools,
      "anthropicFmt:", nAnthropicFmt, "chatCmplFmt:", nChatCmplFmt,
      "nativeToolType:", nNativeToolType, "knownType:", nKnownNativeType,
      "invalid:", nInvalid);
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
  let keptNonFunction = 0;
  for (const tool of parsedBody.tools) {
    if (!isPlainObject(tool)) {
      dropped++;
      toolsFixed = true;
      continue;
    }

    // Step 1: Convert Anthropic/custom tool definitions to
    // Responses {type:"function", ...}. Versioned Anthropic beta tool
    // types carry input_schema; native custom tools produce custom_tool_call,
    // which Chat Completions clients cannot answer with custom_tool_call_output.
    // Convert them to function tools so downstream tool outputs remain compatible.
    const isAnthropicFunctionTool =
      tool.name &&
      !tool.function &&
      (
        !tool.type ||
        tool.type === "custom" ||
        (tool.input_schema && !isKnownResponsesToolType(tool.type))
      );
    if (isAnthropicFunctionTool) {
      const normalized = {
        ...tool,
        type: "function",
        parameters: tool.parameters || tool.input_schema || defaultCustomToolParameters(),
      };
      // description is valid in Responses API — preserve it for tool selection
      delete normalized.input_schema;
      delete normalized.format;
      filtered.push(normalized);
      toolsFixed = true;
      continue;
    }
    // Step 2: Unwrap Chat Completions format { type:"function", function:{...} } → inline
    if (tool.type === "function" && isPlainObject(tool.function)) {
      if (!tool.function.name) {
        dropped++;
        toolsFixed = true;
        continue;
      }
      const normalized = {
        ...tool,
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: tool.function.parameters || {},
      };
      delete normalized.function;
      filtered.push(normalized);
      toolsFixed = true;
      continue;
    }

    // Step 3: Keep already-native Responses tools unchanged. Unknown typed
    // tools are preserved so newer Azure/OpenAI tool types are not stripped.
    if (typeof tool.type === "string" && tool.type) {
      if (tool.type === "function") {
        if (!tool.name) {
          dropped++;
          toolsFixed = true;
          continue;
        }
        if (!isPlainObject(tool.parameters)) {
          filtered.push({ ...tool, parameters: {} });
          toolsFixed = true;
          continue;
        }
      } else {
        keptNonFunction++;
      }
      filtered.push(tool);
      continue;
    }

    dropped++;
    toolsFixed = true;
  }

  if (toolsFixed) {
    parsedBody.tools = filtered;
    const nWithDesc = filtered.filter(t => !!t.description).length;
    const nWithoutDesc = filtered.filter(t => !t.description).length;
    diag("TOOLS_FIXED", "provider:", providerKey, "to:", "openai_responses",
      "kept:", filtered.length, "dropped:", dropped, "nonFunction:", keptNonFunction,
      "withDesc:", nWithDesc, "withoutDesc:", nWithoutDesc);
  }

  return { parsedBody, changed: toolsFixed };
}

// ─── Azure Responses API → OpenAI Chat Completions response mappers ─────────

function responseIncompleteFinishReason(reason) {
  const normalized = String(reason || "").toLowerCase();
  if (normalized.includes("content_filter") || normalized.includes("safety")) {
    return "content_filter";
  }
  if (normalized.includes("tool")) {
    return "tool_calls";
  }
  return "length";
}

function responseErrorFinishReason(response) {
  const code = String(response?.error?.code || response?.incomplete_details?.reason || "").toLowerCase();
  if (code.includes("content_filter") || code.includes("safety")) {
    return "content_filter";
  }
  return "error";
}

function responseFinishReason(response, hasToolCalls = false) {
  if (hasToolCalls) return "tool_calls";

  const status = response?.status || "";
  if (status === "incomplete") {
    return responseIncompleteFinishReason(response?.incomplete_details?.reason);
  }
  if (status === "failed" || status === "cancelled") {
    return responseErrorFinishReason(response);
  }
  return "stop";
}

function responseMetadata(response) {
  return {
    ...(response?.status && response.status !== "completed" ? { response_status: response.status } : {}),
    ...(response?.incomplete_details ? { incomplete_details: response.incomplete_details } : {}),
    ...(response?.error ? { error: response.error } : {}),
  };
}

function isResponsesTerminalEvent(eventName) {
  return AZURE_OPENAI_RESPONSE_TERMINAL_EVENTS.has(eventName);
}

function responsesTerminalStatus(eventName, response) {
  if (response?.status) return response.status;
  switch (eventName) {
    case "response.incomplete":
      return "incomplete";
    case "response.failed":
      return "failed";
    case "response.cancelled":
      return "cancelled";
    case "response.completed":
      return "completed";
    default:
      return null;
  }
}

function mapResponsesTerminalToOpenAI(eventName, response, options = {}) {
  if (!isResponsesTerminalEvent(eventName)) return null;

  const completed = isPlainObject(response) ? response : {};
  const status = responsesTerminalStatus(eventName, completed);
  const responseForReason = { ...completed, ...(status ? { status } : {}) };
  const hasToolCalls = options.hasToolCalls || completed.output?.some((item) => item?.type === "function_call");

  return {
    id: completed.id || "resp_unknown",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: completed.model || "",
    choices: [{
      index: 0,
      delta: {},
      finish_reason: responseFinishReason(responseForReason, hasToolCalls),
    }],
    ...responseMetadata(responseForReason),
  };
}

function mapResponsesToOpenAI(json) {
  if (!json || !Array.isArray(json.output)) {
    if (!json || !["incomplete", "failed", "cancelled"].includes(json.status)) return json;
    return {
      id: json.id || "resp_unknown",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: json.model || "",
      choices: [{
        index: 0,
        message: { role: "assistant", content: null },
        finish_reason: responseFinishReason(json),
      }],
      ...responseMetadata(json),
    };
  }

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
    }
  }

  const finishReason = responseFinishReason(json, toolCalls.length > 0);

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
    ...responseMetadata(json),
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
      const callId = data.call_id || "call_0";
      const idx = data.output_index ?? 0;
      if (!toolState.has(callId)) {
        toolState.set(callId, { id: callId, name: data.name || "", partialJson: "" });
      }
      const state = toolState.get(callId);
      state.partialJson += partial;
      return {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: idx, id: callId, type: "function", function: { name: state.name, arguments: partial } }],
          },
        }],
      };
    }

    case "response.output_item.added": {
      const item = data.item;
      if (item?.type === "message" && item?.role === "assistant") {
        return { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] };
      }
      if (item?.type === "function_call") {
        const callId = item.call_id || "call_0";
        const idx = data.output_index ?? 0;
        toolState.set(callId, { id: callId, name: item.name || "", partialJson: "" });
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: idx, id: callId, type: "function", function: { name: item.name || "", arguments: "" } }],
            },
          }],
        };
      }
      return null;
    }

    default:
      return null;
  }
}

// ─── End Azure Responses API mappers ────────────────────────────────────────

export {
  isAzureReasoningModel,
  isResponsesTerminalEvent,
  mapResponsesSSEToOpenAI,
  mapResponsesTerminalToOpenAI,
  mapResponsesToOpenAI,
  normalizeAzureOpenAIInputContent,
  normalizeAzureOpenAITools,
  sanitizeAzureOpenAIBody,
};
