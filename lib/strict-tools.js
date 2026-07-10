import { createLogger } from "./logger.js";

// Emits under the proxy tag: the STRICT_TOOLS_PROBE line is part of the
// request-orchestration log stream that dashboards filter on.
const { diag } = createLogger("proxy");

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
export function probeStrictTools(providerKey, parsedBody) {
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
