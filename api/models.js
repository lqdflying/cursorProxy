const PUBLIC_MODEL_PREFIX = "cursorproxy/";
const LEGACY_AZURE_MODEL_PREFIX = "azure/";

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

export function withPublicResponseModel(json, fallbackModel) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;

  const fallbackPublicId = publicModelId(fallbackModel);
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

export function providerFromModel(model) {
  if (typeof model !== "string" || !model) return null;
  const parts = modelIdParts(model);
  const m = parts.bare.toLowerCase();
  // Backward compatibility: legacy azure/ IDs still route to Azure, but are
  // normalized to cursorproxy/ IDs at the client-facing boundary.
  if (parts.hadLegacyAzurePrefix) {
    return m.startsWith("claude") ? "azureanthropic" : "azureopenai";
  }
  if (m.startsWith("claude")) return "azureanthropic";
  if (m.startsWith("gpt-") || /^o\d/i.test(m)) return "azureopenai";
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("kimi")) return "kimi";
  if (m.startsWith("deepseek")) return "deepseek";
  return null;
}
