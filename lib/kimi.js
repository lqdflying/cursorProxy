import { createLogger } from "./logger.js";
import { summarizeToolChoiceForLog } from "./log-shapes.js";

const { diag } = createLogger("proxy");

const KIMI_THINKING_MIN_TOKENS = 16_000;

const KIMI_K2_FIXED_VALUE_PARAMS = [
  "temperature",
  "top_p",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "reasoning_effort",
];

const KIMI_K3_FIXED_VALUE_PARAMS = [
  "temperature",
  "top_p",
  "n",
  "presence_penalty",
  "frequency_penalty",
];

function normalizeBareModel(bareModel) {
  return typeof bareModel === "string" ? bareModel.trim().toLowerCase() : "";
}

export function isKimiK3(bareModel) {
  return normalizeBareModel(bareModel) === "kimi-k3";
}

export function isKimiThinkingModel(bareModel) {
  const m = normalizeBareModel(bareModel);
  if (!m.startsWith("kimi")) return false;
  return isKimiK3(m)
    || m === "kimi-k2.7-code"
    || m.startsWith("kimi-k2.6")
    || m.startsWith("kimi-k2.5");
}

export function isKimiModel(bareModel) {
  return normalizeBareModel(bareModel).startsWith("kimi");
}

function isKimiK27Code(bareModel) {
  return normalizeBareModel(bareModel) === "kimi-k2.7-code";
}

function isKimiK26(bareModel) {
  return normalizeBareModel(bareModel).startsWith("kimi-k2.6");
}

function isKimiK25(bareModel) {
  return normalizeBareModel(bareModel).startsWith("kimi-k2.5");
}

function normalizeToolChoice(parsedBody) {
  const tc = parsedBody.tool_choice;
  if (tc == null || tc === "auto" || tc === "none") return false;

  parsedBody.tool_choice = "auto";
  diag("KIMI_TOOL_CHOICE_FIXED", "from:", JSON.stringify(tc), "to:", "auto");
  return true;
}

function normalizeMaxTokens(parsedBody) {
  let changed = false;

  if (parsedBody.max_tokens == null && parsedBody.max_completion_tokens != null) {
    parsedBody.max_tokens = parsedBody.max_completion_tokens;
    changed = true;
  }

  if (parsedBody.max_completion_tokens != null) {
    delete parsedBody.max_completion_tokens;
    changed = true;
  }

  if (parsedBody.max_tokens != null && parsedBody.max_tokens < KIMI_THINKING_MIN_TOKENS) {
    parsedBody.max_tokens = KIMI_THINKING_MIN_TOKENS;
    changed = true;
  }

  return changed;
}

function applyThinkingRules(parsedBody, bareModel) {
  if (isKimiK27Code(bareModel)) {
    if (!Object.prototype.hasOwnProperty.call(parsedBody, "thinking")) return false;
    delete parsedBody.thinking;
    return true;
  }

  if (isKimiK26(bareModel)) {
    const clientType = parsedBody.thinking?.type;
    if (clientType === "disabled") return false;

    const next = { type: "enabled", keep: "all" };
    const changed = !parsedBody.thinking
      || parsedBody.thinking.type !== next.type
      || parsedBody.thinking.keep !== next.keep;
    parsedBody.thinking = next;
    return changed;
  }

  if (isKimiK25(bareModel)) {
    let changed = false;
    if (!parsedBody.thinking) {
      parsedBody.thinking = { type: "enabled" };
      changed = true;
    }
    if (parsedBody.thinking?.keep != null) {
      delete parsedBody.thinking.keep;
      changed = true;
    }
    return changed;
  }

  return false;
}

// Decode a single JSON Pointer segment.  Per RFC 6901, `~1` is `/` and `~0`
// is `~`, applied in that order.
function decodeJsonPointerSegment(seg) {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

// Resolve a JSON Schema local $ref pointer (e.g. #/definitions/Foo) within the
// root schema document. Returns the referenced value, or undefined if not found.
function resolveLocalRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;

  const segments = ref.slice(2).split("/").map(decodeJsonPointerSegment);
  let current = root;
  for (const seg of segments) {
    if (current === undefined || current === null) return undefined;
    current = current[seg];
  }
  return current;
}

// Build a deterministic, Kimi-safe base name for a hoisted definition.
function makeBaseDefName(ref) {
  const suffix = ref.startsWith("#/")
    ? ref.slice(2).replace(/[^a-zA-Z0-9]/g, "_")
    : String(ref).replace(/[^a-zA-Z0-9]/g, "_");
  return "ref_" + suffix;
}

// Keywords whose values are arbitrary JSON data, not sub-schemas.  `$ref`
// strings inside these values are data, not schema references.
const NON_SCHEMA_VALUE_KEYS = new Set([
  "const",
  "default",
  "examples",
  "enum",
]);

// Collect every local `$ref` string found in schema syntax, recursively.
// This is a non-mutating read pass, so it cannot produce cycles even on
// recursive input.  Refs inside `const`, `default`, `examples`, and `enum`
// are ignored because they are data values, not schema references.
function collectLocalRefs(node, out = new Set(), inDataValue = false) {
  if (Array.isArray(node)) {
    for (const item of node) collectLocalRefs(item, out, inDataValue);
    return out;
  }
  if (!node || typeof node !== "object") return out;

  if (!inDataValue && typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    out.add(node.$ref);
  }
  for (const key of Object.keys(node)) {
    collectLocalRefs(node[key], out, inDataValue || NON_SCHEMA_VALUE_KEYS.has(key));
  }
  return out;
}

// Normalize JSON Schema references for the Kimi/Moonshot API.  Kimi accepts
// only `$ref` values that start with `#/$defs/`.  Cursor subagents may send
// Draft-4 style `#/definitions/X` or self-references such as
// `#/properties/foo`, both of which are rejected upstream.
//
// Strategy: hoist every non-compliant local definition into the root `$defs`
// under a generated name, then rewrite all `$ref` values to point at those
// hoisted definitions.  Each distinct reference string gets its own
// collision-safe name, so two schemas referenced by different pointers are
// never merged.  Recursive / cyclic schemas are handled by tracking the names
// of refs already being hoisted and reusing them, so the output remains
// acyclic.
function normalizeJsonSchemaRefs(schema) {
  if (!schema || typeof schema !== "object") return { changed: false };

  const root = schema;
  const nameByRef = new Map();
  const hasDefinitions = Object.prototype.hasOwnProperty.call(root, "definitions");
  let removedRefCount = 0;

  function ensureDefs() {
    if (!root.$defs) root.$defs = {};
  }

  function allocateName(ref) {
    const base = makeBaseDefName(ref);
    ensureDefs();

    // Two different refs can normalize to the same base name (e.g. #/a/b and
    // #/a_b).  Claim a unique slot without overwriting existing entries.
    let name = base;
    let attempt = 1;
    while (Object.prototype.hasOwnProperty.call(root.$defs, name)) {
      name = `${base}_${attempt++}`;
    }
    return name;
  }

  function removeRef(node) {
    delete node.$ref;
    removedRefCount++;
  }

  function ensureHoisted(ref, pending = new Set()) {
    if (nameByRef.has(ref)) return nameByRef.get(ref);
    if (pending.has(ref)) {
      const name = allocateName(ref);
      nameByRef.set(ref, name);
      if (!root.$defs[name]) root.$defs[name] = {};
      return name;
    }

    const target = resolveLocalRef(root, ref);
    if (target === undefined || target === null || typeof target !== "object" || Array.isArray(target)) {
      return null;
    }

    const name = allocateName(ref);
    nameByRef.set(ref, name);
    if (!root.$defs[name]) root.$defs[name] = {};

    pending.add(ref);

    const clone = root.$defs[name];
    Object.assign(clone, JSON.parse(JSON.stringify(target)));
    normalizeNode(clone, pending);

    pending.delete(ref);
    return name;
  }

  function normalizeNode(node, pending, inDataValue = false) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) normalizeNode(node[i], pending, inDataValue);
      return;
    }
    if (!node || typeof node !== "object") return;

    if (!inDataValue && typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/")) {
        // External / non-local reference: Kimi only accepts local refs, so
        // the upstream request would 400.  Remove the ref to keep the tool
        // usable; the property becomes an empty schema {}.
        removeRef(node);
      } else if (!ref.startsWith("#/$defs/")) {
        const name = ensureHoisted(ref, pending);
        if (name) {
          node.$ref = "#/$defs/" + name;
        } else {
          diag(
            "KIMI_TOOL_SCHEMA_REF_REMOVED",
            "ref:", ref,
          );
          removeRef(node);
        }
      }
    }

    for (const key of Object.keys(node)) {
      normalizeNode(node[key], pending, inDataValue || NON_SCHEMA_VALUE_KEYS.has(key));
    }
  }

  const refs = collectLocalRefs(root);
  for (const ref of refs) {
    if (ref.startsWith("#/$defs/")) continue;
    ensureHoisted(ref);
  }

  normalizeNode(root, new Set());

  if (hasDefinitions) {
    if (typeof root.definitions === "object" && !Array.isArray(root.definitions)) {
      ensureDefs();
      for (const key of Object.keys(root.definitions)) {
        if (!Object.prototype.hasOwnProperty.call(root.$defs, key)) {
          root.$defs[key] = root.definitions[key];
        }
      }
    }
    delete root.definitions;
  }

  // Avoid leaving an empty `$defs` object behind.
  if (root.$defs && Object.keys(root.$defs).length === 0) {
    delete root.$defs;
  }

  const changed = nameByRef.size > 0 || removedRefCount > 0 || hasDefinitions;
  return { changed };
}

function normalizeKimiToolSchemas(parsedBody) {
  const tools = parsedBody.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;

  let fixed = 0;
  const indicesToRemove = [];

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const params = tool?.function?.parameters;
    if (!params || typeof params !== "object") continue;

    try {
      const result = normalizeJsonSchemaRefs(params);
      if (result.changed) fixed++;
    } catch (err) {
      const toolName = tool?.function?.name || "(unnamed)";
      indicesToRemove.push(i);
      fixed++;
      diag(
        "KIMI_TOOL_SCHEMA_REMOVED",
        "tool:", toolName,
        "reason:", err?.message || "schema normalization failed",
      );
    }
  }

  // Remove only tools whose normalization failed, preserving order.
  if (indicesToRemove.length > 0) {
    parsedBody.tools = tools.filter((_, idx) => !indicesToRemove.includes(idx));
    if (parsedBody.tools.length === 0) delete parsedBody.tools;
  }

  return fixed;
}

function applyKimiThinkingSanitization(parsedBody, bareModel) {
  if (!isKimiThinkingModel(bareModel)) return false;

  if (isKimiK3(bareModel)) {
    let changed = false;

    for (const key of KIMI_K3_FIXED_VALUE_PARAMS) {
      if (Object.prototype.hasOwnProperty.call(parsedBody, key)) {
        delete parsedBody[key];
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(parsedBody, "thinking")) {
      delete parsedBody.thinking;
      changed = true;
    }

    if (parsedBody.reasoning_effort !== "max") {
      parsedBody.reasoning_effort = "max";
      changed = true;
    }

    return changed;
  }

  let changed = false;

  for (const key of KIMI_K2_FIXED_VALUE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(parsedBody, key)) {
      delete parsedBody[key];
      changed = true;
    }
  }

  if (normalizeToolChoice(parsedBody)) changed = true;
  if (normalizeMaxTokens(parsedBody)) changed = true;
  if (applyThinkingRules(parsedBody, bareModel)) changed = true;

  return changed;
}

export function sanitizeKimiBody(parsedBody, bareModel, providerKey) {
  if (!parsedBody) return false;

  const isKimiProvider = providerKey === "kimi";
  const isKimiModelName = isKimiModel(bareModel);
  if (!isKimiProvider && !isKimiModelName) return false;

  let changed = false;
  let toolRefsFixed = 0;

  if (applyKimiThinkingSanitization(parsedBody, bareModel)) changed = true;

  toolRefsFixed = normalizeKimiToolSchemas(parsedBody);
  if (toolRefsFixed > 0) changed = true;

  if (changed) {
    diag(
      "KIMI_BODY_SANITIZED",
      "model:", bareModel,
      "thinkingType:", parsedBody.thinking?.type || "(omitted)",
      "reasoningEffort:", parsedBody.reasoning_effort ?? "(unset)",
      "toolChoice:", summarizeToolChoiceForLog(parsedBody.tool_choice),
      "maxTokens:", parsedBody.max_tokens ?? "(unset)",
      "maxCompletionTokens:", parsedBody.max_completion_tokens ?? "(unset)",
      "toolRefsFixed:", toolRefsFixed || "(none)",
    );
  }

  return changed;
}
