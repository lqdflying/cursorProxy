import { allowedEnvValue } from "./auth.js";
import { createLogger } from "./logger.js";

const { diag } = createLogger("azure-anthropic");

const AZURE_ANTHROPIC_THINKING_TYPES = new Set(["adaptive", "disabled"]);
const AZURE_ANTHROPIC_EFFORT_LEVELS = new Set(["low", "medium", "high", "max"]);

function remapAnthropicInput(providerKey, parsedBody) {
  if (providerKey !== "azureanthropic" || !parsedBody) {
    return { parsedBody, changed: false };
  }

  // Cursor sends the messages array under "input" for Azure models.
  // Remap to "messages" so Anthropic can process the request.
  if (parsedBody.input && !parsedBody.messages) {
    parsedBody.messages = parsedBody.input;
    delete parsedBody.input;
    diag("INPUT_REMAPPED", "provider:", providerKey, "from:", "input", "to:", "messages");
    return { parsedBody, changed: true };
  }

  return { parsedBody, changed: false };
}

function normalizeAnthropicContentTypes(providerKey, parsedBody) {
  if (providerKey !== "azureanthropic" || !parsedBody?.messages) {
    return { parsedBody, changed: false };
  }

  // Normalize content block types for Azure Anthropic.
  // Cursor occasionally sends input_text / output_text (Responses API style)
  // but Anthropic Messages API expects type: "text". Keep tool_use/tool_result
  // intact since those are Anthropic-native block types.
  const typeMap = { input_text: "text", output_text: "text" };
  let fixed = false;
  for (const msg of parsedBody.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeMap[part.type]) {
          part.type = typeMap[part.type];
          fixed = true;
        }
      }
    }
  }

  if (fixed) {
    diag("ANTHROPIC_CONTENT_FIXED", "provider:", providerKey, "from:", "input_text/output_text", "to:", "text");
  }

  return { parsedBody, changed: fixed };
}

function sanitizeAzureAnthropicBody(providerKey, parsedBody) {
  if (providerKey !== "azureanthropic" || !parsedBody) {
    return { parsedBody, sanitized: false };
  }

  let sanitized = false;

  // Cursor/Responses-style requests may send "instructions" instead of "system"
  if ("instructions" in parsedBody && typeof parsedBody.instructions === "string") {
    if (!parsedBody.system) {
      parsedBody.system = parsedBody.instructions;
    }
    delete parsedBody.instructions;
    sanitized = true;
  }

  // Map OpenAI-style reasoning_effort to Anthropic output_config.effort.
  // Azure Claude accepts low/medium/high/max; ignore OpenAI-only values like "none".
  if ("reasoning_effort" in parsedBody) {
    if (AZURE_ANTHROPIC_EFFORT_LEVELS.has(parsedBody.reasoning_effort)) {
      if (!parsedBody.output_config || typeof parsedBody.output_config !== "object" || Array.isArray(parsedBody.output_config)) {
        parsedBody.output_config = {};
      }
      if (!parsedBody.output_config.effort) {
        parsedBody.output_config.effort = parsedBody.reasoning_effort;
      }
    }
    delete parsedBody.reasoning_effort;
    sanitized = true;
  }

  const defaultThinking = allowedEnvValue("AZURE_ANTHROPIC_THINKING", AZURE_ANTHROPIC_THINKING_TYPES);
  if (defaultThinking && !("thinking" in parsedBody)) {
    parsedBody.thinking = { type: defaultThinking };
    sanitized = true;
  }

  const defaultEffort = allowedEnvValue("AZURE_ANTHROPIC_EFFORT", AZURE_ANTHROPIC_EFFORT_LEVELS);
  if (defaultEffort) {
    if (!parsedBody.output_config || typeof parsedBody.output_config !== "object" || Array.isArray(parsedBody.output_config)) {
      parsedBody.output_config = {};
    }
    if (!parsedBody.output_config.effort) {
      parsedBody.output_config.effort = defaultEffort;
      sanitized = true;
    }
  }

  // Anthropic uses `max_tokens`, not `max_completion_tokens`
  if ("max_completion_tokens" in parsedBody && !("max_tokens" in parsedBody)) {
    parsedBody.max_tokens = parsedBody.max_completion_tokens;
    delete parsedBody.max_completion_tokens;
    sanitized = true;
  }
  const allowed = new Set([
    "model", "messages", "system", "max_tokens", "temperature",
    "top_p", "top_k", "stream", "stop_sequences", "tools", "tool_choice",
    "metadata", "thinking", "output_config",
  ]);
  for (const key of Object.keys(parsedBody)) {
    if (!allowed.has(key)) {
      delete parsedBody[key];
      sanitized = true;
    }
  }

  if (sanitized) {
    diag("AZURE_BODY_SANITIZED", "provider:", providerKey);
  }

  if (parsedBody.thinking?.type) {
    diag("ANTHROPIC_THINKING", "type:", parsedBody.thinking.type, "provider:", providerKey);
  }
  if (parsedBody.output_config?.effort) {
    diag("ANTHROPIC_EFFORT", "effort:", parsedBody.output_config.effort, "provider:", providerKey);
  }

  return { parsedBody, sanitized };
}

/**
 * Convert an Anthropic non-streaming response to OpenAI-compatible format.
 *
 * Anthropic: { id, type: "message", role: "assistant", content: [{type:"text",text:"..."}, {type:"tool_use",id,name,input:{}}], stop_reason, usage }
 * OpenAI:    { id, object: "chat.completion", created, model, choices: [{index, message: {role,content,tool_calls}, finish_reason}], usage }
 */
function mapAnthropicResponseToOpenAI(json) {
  if (json.type !== "message") return json; // not an Anthropic response, pass through

  // Extract text from content blocks
  let textContent = "";
  const toolCalls = [];
  if (Array.isArray(json.content)) {
    for (const block of json.content) {
      if (block.type === "text") {
        textContent += block.text || "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || "",
          type: "function",
          function: {
            name: block.name || "",
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
    textContent = textContent.trimStart();
  }

  // Map stop_reason
  const stopMap = {
    "end_turn": "stop",
    "max_tokens": "length",
    "stop_sequence": "stop",
    "tool_use": "tool_calls",
  };
  const finishReason = stopMap[json.stop_reason] || json.stop_reason || "stop";

  const result = {
    id: json.id || "msg_unknown",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: json.model || json.id,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textContent || null,
      },
      finish_reason: finishReason,
    }],
  };

  if (toolCalls.length > 0) {
    result.choices[0].message.tool_calls = toolCalls;
  }

  if (json.usage) {
    result.usage = {
      prompt_tokens: json.usage.input_tokens ?? 0,
      completion_tokens: json.usage.output_tokens ?? 0,
      total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
    };
  }

  return result;
}

/**
 * Convert an Anthropic SSE event into an OpenAI-compatible SSE chunk.
 *
 * Anthropic streaming events use content_block_delta with delta.text_delta,
 * and message_delta with delta.stop_reason. OpenAI expects choices[0].delta.content
 * (string) and choices[0].finish_reason.
 *
 * Supported Anthropic event types:
 * - content_block_start: first block of content (type text → role: "assistant")
 * - content_block_delta: incremental text delta
 * - content_block_stop: stop the current block (ignored for output)
 * - message_delta: stop_reason and usage (converted to finish_reason)
 * - message_start / message_stop: ignored, no output content
 * - ping: keepalive, ignored
 *
 * Returns a synthetic OpenAI chunk object, "[DONE]" string, or null if the event produces no output.
 *
 * @param {object} json - The parsed Anthropic SSE data event
 * @param {Map} toolState - Map of index -> { id, name, partialJson } for tracking tool_use blocks
 */
function mapAnthropicSSEToOpenAI(json, toolState) {
  const event = json; // Anthropic SSE events are flat, e.g. { type: "content_block_delta", ... }

  // ignore keepalive and structural events
  if (!event || !event.type) return null;

  switch (event.type) {
    case "content_block_start": {
      const idx = event.index ?? 0;
      const block = event.content_block;
      // Text/thinking: emit role marker
      if (block?.type === "text" || block?.type === "thinking") {
        return {
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
          }],
        };
      }
      // Tool use: store id/name for later input_json_delta accumulation
      if (block?.type === "tool_use" && block.id) {
        toolState.set(idx, { id: block.id, name: block.name, partialJson: "" });
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" },
              }],
            },
          }],
        };
      }
      return null;
    }

    case "content_block_delta": {
      const idx = event.index ?? 0;
      const delta = event.delta;
      // text_delta: { type: "text_delta", text: "Hello" }
      // thinking_delta: { type: "thinking_delta", thinking: "..." }
      if (delta?.type === "text_delta" || delta?.type === "thinking_delta") {
        const text = delta.text ?? delta.thinking ?? "";
        return {
          choices: [{
            index: 0,
            delta: { content: text },
          }],
        };
      }
      // input_json_delta: { type: "input_json_delta", partial_json: "..." }
      if (delta?.type === "input_json_delta") {
        const partial = delta.partial_json ?? "";
        const state = toolState.get(idx);
        if (state) {
          state.partialJson += partial;
          return {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: idx,
                  function: { arguments: partial },
                }],
              },
            }],
          };
        }
        // No matching start event — emit partial anyway as text
        return {
          choices: [{
            index: idx,
            delta: { content: partial },
          }],
        };
      }
      return null;
    }

    case "content_block_stop": {
      const idx = event.index ?? 0;
      // Finalize tool_use blocks: emit empty delta to signal completion
      if (toolState.has(idx)) {
        toolState.delete(idx);
        // Some Cursor versions need an empty tool_calls delta to finalize
        return {
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: idx, function: { arguments: "" } }] },
          }],
        };
      }
      return null;
    }

    case "message_delta": {
      const finishReason = event.delta?.stop_reason ?? null;
      const usage = event.usage ?? null;

      // Anthropic stop_reason values: "end_turn", "max_tokens", "stop_sequence", "tool_use"
      // Map to OpenAI finish_reason values
      const finishMap = {
        "end_turn": "stop",
        "max_tokens": "length",
        "stop_sequence": "stop",
        "tool_use": "tool_calls",
      };
      const mappedFinish = finishReason ? (finishMap[finishReason] || finishReason) : null;

      const chunk = { choices: [{ index: 0, delta: {} }] };

      if (mappedFinish) {
        chunk.choices[0].finish_reason = mappedFinish;
      }

      if (usage) {
        chunk.usage = {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        };
      }

      return chunk;
    }

    case "message_start":
    case "ping":
      return null;

    case "message_stop":
      // Signal end of Anthropic message stream — equivalent to OpenAI's [DONE]
      return "[DONE]";

    case "error":
      // Pass through errors
      return { choices: [{ index: 0, delta: {}, finish_reason: "error" }] };

    default:
      // Unknown events — pass through as-is
      return null;
  }
}

export {
  mapAnthropicResponseToOpenAI,
  mapAnthropicSSEToOpenAI,
  normalizeAnthropicContentTypes,
  remapAnthropicInput,
  sanitizeAzureAnthropicBody,
};
