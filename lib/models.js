const PUBLIC_MODEL_PREFIX = "cursorproxy/";
const LEGACY_AZURE_MODEL_PREFIX = "azure/";

// Azure OpenAI alias registry. Public model ids in this map resolve to a real
// Azure Foundry deployment via the env var named in `targetEnv`. Each alias
// also carries an optional `effortEnv` whose value (when set) overrides the
// global AZURE_OPENAI_REASONING_EFFORT for requests that route through the
// alias. The alias name is matched against the *bare* model id, i.e. after
// `cursorproxy/` (or legacy `azure/`) has been stripped by `modelIdParts()`.
const AZURE_OPENAI_ALIASES = {
  "gpt-general": {
    targetEnv: "AZURE_OPENAI_GENERAL_ALIAS_TARGET",
    effortEnv: "AZURE_OPENAI_GENERAL_REASONING_EFFORT",
  },
};

function readAliasEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^(["'])(.*)\1$/, "$2");
}

export function modelIdParts(model) {
  if (typeof model !== "string") {
    return {
      input: "",
      bare: "",
      publicId: "",
      hadPublicPrefix: false,
      hadLegacyAzurePrefix: false,
    };
  }

  let id = model.trim();
  const lower = id.toLowerCase();
  const hadPublicPrefix = lower.startsWith(PUBLIC_MODEL_PREFIX);
  if (hadPublicPrefix) {
    id = id.slice(PUBLIC_MODEL_PREFIX.length);
  }

  const lowerAfterPublic = id.toLowerCase();
  const hadLegacyAzurePrefix = lowerAfterPublic.startsWith(LEGACY_AZURE_MODEL_PREFIX);
  if (hadLegacyAzurePrefix) {
    id = id.slice(LEGACY_AZURE_MODEL_PREFIX.length);
  }

  const bare = id.trim();
  return {
    input: model,
    bare,
    publicId: bare ? PUBLIC_MODEL_PREFIX + bare : "",
    hadPublicPrefix,
    hadLegacyAzurePrefix,
  };
}

export function publicModelId(model) {
  return modelIdParts(model).publicId;
}

export function withPublicResponseModel(json, fallbackModel, forceAlias = false) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;

  // Error envelopes flow through unchanged. Even shapes like
  // `{ error: {...}, model: "<deployment>" }` must not be normalized:
  // any rewriting risks confusing client error parsers and leaks the
  // resolved deployment name when a forced-alias request fails upstream.
  if (json.error) return json;

  const fallbackPublicId = publicModelId(fallbackModel);

  // When an alias is in use, the upstream `json.model` is the resolved
  // deployment name (e.g. "gpt-5.5-mini"). Force the response model back
  // to the alias public id so callers see the model they asked for.
  //
  // Restricted to payloads that look like a chat completion (have `choices`).
  const looksLikeCompletion = Array.isArray(json.choices);
  if (forceAlias && fallbackPublicId && looksLikeCompletion) {
    return { ...json, model: fallbackPublicId };
  }

  const currentPublicId = publicModelId(json.model);
  if (currentPublicId) return { ...json, model: currentPublicId };

  const shouldAddFallback = fallbackPublicId && Array.isArray(json.choices);
  if (!shouldAddFallback) return json;

  return { ...json, model: fallbackPublicId };
}

export function normalizeParsedBodyModel(parsedBody) {
  if (!parsedBody?.model) {
    return { input: "", bare: "", publicId: "", changed: false };
  }

  const parts = modelIdParts(parsedBody.model);
  const changed = Boolean(parts.bare && parsedBody.model !== parts.bare);
  if (changed) {
    parsedBody.model = parts.bare;
  }
  return { ...parts, changed };
}

export function configuredModelIds() {
  const raw = process.env.CURSORPROXY_MODELS || "";
  const seen = new Set();
  const models = [];

  for (const value of raw.split(/[,\r\n]+/)) {
    const id = publicModelId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }

  return models;
}

export function isModelDiscoveryRequest(req, pathname, pathParam) {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const normalizedPathParam = pathParam.replace(/^\/+|\/+$/g, "");
  return normalizedPathParam === "models" || pathname === "/v1/models" || pathname === "/v0/models";
}

export function modelDiscoveryResponse(req) {
  const body = JSON.stringify({
    object: "list",
    data: configuredModelIds().map((id) => ({
      id,
      object: "model",
      owned_by: "cursorProxy",
    })),
  });

  return new Response(req.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * Map a Fireworks-prefixed bare model name to the full Fireworks model ID.
 * "fireworks/kimi-k2.7-code" → "accounts/fireworks/models/kimi-k2.7-code"
 */
const FIREWORKS_PREFIX = "fireworks/";
export function resolveFireworksModel(bare) {
  if (typeof bare !== "string" || !bare.toLowerCase().startsWith(FIREWORKS_PREFIX)) return null;
  let core = bare.slice(FIREWORKS_PREFIX.length);
  if (!core) return null;
  // If the part after fireworks/ already starts with accounts/ it is a fully
  // qualified custom model ID (e.g. accounts/acme/models/private-model).
  if (/^accounts\//i.test(core)) return core;
  return "accounts/fireworks/models/" + core;
}

export function providerFromModel(model) {
  if (typeof model !== "string" || !model) return null;
  const parts = modelIdParts(model);
  const m = parts.bare.toLowerCase();
  // Fireworks prefix must be checked BEFORE kimi/deepseek/glm so that
  // "fireworks/kimi-*" routes to Fireworks, not the Kimi provider.
  if (m.startsWith(FIREWORKS_PREFIX)) return "fireworks";
  // Fully qualified Fireworks model IDs (accounts/fireworks/models/<name>
  // and custom accounts/<account>/models/<name>) must route to Fireworks
  // even when the user omits the fireworks/ prefix.
  if (/^accounts\/.+\/models\//i.test(m)) return "fireworks";
  // Backward compatibility: legacy azure/ IDs still route to Azure, but are
  // normalized to cursorproxy/ IDs at the client-facing boundary.
  if (parts.hadLegacyAzurePrefix) {
    return m.startsWith("claude") ? "azureanthropic" : "azureopenai";
  }
  if (m.startsWith("claude")) return "azureanthropic";
  // Azure OpenAI aliases route to azureopenai even when the alias name
  // doesn't start with `gpt-` / `o<digit>`. The actual deployment is
  // resolved later via resolveAzureAlias().
  if (Object.prototype.hasOwnProperty.call(AZURE_OPENAI_ALIASES, m)) {
    return "azureopenai";
  }
  if (m.startsWith("gpt-") || /^o\d/i.test(m)) return "azureopenai";
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("mimo")) return "mimo";
  if (m.startsWith("kimi")) return "kimi";
  if (m.startsWith("deepseek")) return "deepseek";
  return null;
}

// Resolve an Azure OpenAI alias name to its real deployment name.
//
// `bare` is the model id after `cursorproxy/` / legacy `azure/` prefix
// stripping (i.e. `modelIdParts(model).bare`).
//
// Return values:
//   - `null` when `bare` is not a registered alias.
//   - `{ aliasName, target, effortEnv, targetEnv, configured: false }`
//     when the alias is registered but its target env var is unset/blank.
//     The proxy uses `configured: false` to surface a clear configuration
//     error to clients instead of forwarding a request that would 400.
//   - `{ aliasName, target, effortEnv, targetEnv, configured: true }`
//     when the target deployment was successfully resolved. `target` is
//     the bare deployment name (any `cursorproxy/` prefix accidentally
//     placed in the env var is stripped here defensively).
export function resolveAzureAlias(bare) {
  if (typeof bare !== "string" || !bare) return null;
  const key = bare.toLowerCase();
  const meta = Object.prototype.hasOwnProperty.call(AZURE_OPENAI_ALIASES, key)
    ? AZURE_OPENAI_ALIASES[key]
    : null;
  if (!meta) return null;

  const rawTarget = readAliasEnv(meta.targetEnv);
  if (!rawTarget) {
    return {
      aliasName: key,
      target: "",
      effortEnv: meta.effortEnv || null,
      targetEnv: meta.targetEnv,
      configured: false,
    };
  }

  // Defensive: strip any `cursorproxy/` / `azure/` prefix the operator
  // may have accidentally written into the env var.
  const target = modelIdParts(rawTarget).bare;
  return {
    aliasName: key,
    target,
    effortEnv: meta.effortEnv || null,
    targetEnv: meta.targetEnv,
    configured: Boolean(target),
  };
}
