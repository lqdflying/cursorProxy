// Cursor client tool handling: sanitize Cursor-specific tool-call arguments
// (Subagent/Task/Shell) for local execution, and remap Responses-API tool-arg
// stream events into Chat Completions tool_calls deltas. Pure functions — no
// logging; callers emit their own [cursorProxy:proxy] lines.

export function isCursorSubagentToolName(name) {
  return String(name || "").trim().toLowerCase() === "subagent";
}

export function isCursorTaskToolName(name) {
  return String(name || "").trim().toLowerCase() === "task";
}

export function isCursorShellToolName(name) {
  return String(name || "").trim().toLowerCase() === "shell";
}

const CURSOR_SUBAGENT_CLOUD_ONLY_ARG_KEYS = new Set([
  "cloud_base_branch",
  "environment",
  "file_attachments",
]);

export function sanitizeCursorSubagentArgsForLocal(rawArgs) {
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

export function sanitizeCursorTaskArgs(rawArgs) {
  const text = typeof rawArgs === "string" ? rawArgs : "";
  if (!text.trim()) return { argsText: text, removed: [], parseError: false };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { argsText: text, removed: [], parseError: false };
    }

    const removed = [];
    const environment = typeof parsed.environment === "string"
      ? parsed.environment.trim().toLowerCase()
      : "";
    const cloudBaseBranch = parsed.cloud_base_branch;
    const shouldRemoveCloudBaseBranch = Object.prototype.hasOwnProperty.call(
      parsed,
      "cloud_base_branch",
    ) && (
      environment !== "cloud"
      || typeof cloudBaseBranch !== "string"
      || !cloudBaseBranch.trim()
    );
    if (shouldRemoveCloudBaseBranch) {
      delete parsed.cloud_base_branch;
      removed.push("cloud_base_branch");
    }

    for (const key of ["model", "resume"]) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      const value = parsed[key];
      if (value != null && (typeof value !== "string" || value.trim())) continue;
      delete parsed[key];
      removed.push(key);
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

export function sanitizeCursorShellArgsForLocal(rawArgs) {
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

export function mapResponsesToolArgsChunkForProxy(state, argsText) {
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

export function mapResponsesToolArgsContinuationForProxy(state, argsText) {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: state.toolIndex,
          function: { arguments: argsText },
        }],
      },
    }],
  };
}

export function mapMissingResponsesToolArgsForProxy(state, finalArgsText) {
  if (!state || typeof finalArgsText !== "string") return null;
  const priorArgs = state.partialJson || "";
  if (finalArgsText === priorArgs) return null;
  if (!finalArgsText.startsWith(priorArgs)) return null;
  const suffix = finalArgsText.slice(priorArgs.length);
  if (!suffix) return null;
  state.partialJson = finalArgsText;
  return mapResponsesToolArgsChunkForProxy(state, suffix);
}
