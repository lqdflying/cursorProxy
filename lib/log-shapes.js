// Log-shape summarizers: format request/stream details into safe, compact
// key/value fragments for [cursorProxy:proxy] log lines. These functions only
// build arguments — they never emit; callers pass the results to their own
// log()/diag().

export function safeLogToken(value, fallback = "(none)") {
  if (value == null || value === "") return fallback;
  return String(value).replace(/\s+/g, "_").slice(0, 80);
}

export function summarizeToolChoiceForLog(value) {
  if (value == null || value === "") return "(none)";
  if (typeof value === "string") return safeLogToken(value);
  if (typeof value !== "object" || Array.isArray(value)) return typeof value;
  const type = value.type ? safeLogToken(value.type) : "object";
  const functionShape = value.function && typeof value.function === "object" ? "function" : "";
  return functionShape ? `${type}:${functionShape}` : type;
}

export function summarizeJsonArgKeysForLog(rawArgs) {
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

export function summarizeToolArgShapeForLog(toolName, rawArgs) {
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

export function responsesToolStateForLog(toolState, data) {
  const idx = data?.output_index ?? 0;
  return (data?.call_id && toolState.get(data.call_id))
    || (data?.item_id && toolState.get(`item:${data.item_id}`))
    || toolState.get(`index:${idx}`)
    || null;
}

export function isResponsesToolDoneEvent(eventName) {
  return eventName === "response.function_call_arguments.done"
    || eventName === "response.custom_tool_call_input.done"
    || eventName === "response.apply_patch_call.done"
    || eventName === "response.apply_patch_call_input.done";
}

export function responsesToolArgsForLog(data, state) {
  if (typeof data?.arguments === "string") return data.arguments;
  if (typeof data?.input === "string") return data.input;
  if (typeof data?.patch === "string") return data.patch;
  return state?.partialJson || "";
}

export function isResponsesToolArgDeltaEvent(eventName) {
  return eventName === "response.function_call_arguments.delta"
    || eventName === "response.custom_tool_call_input.delta"
    || eventName === "response.apply_patch_call.delta"
    || eventName === "response.apply_patch_call_input.delta";
}
