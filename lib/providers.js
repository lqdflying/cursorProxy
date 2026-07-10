import { openaiCompatWireApi } from "./models.js";

// Central upstream provider registry. Eager `url:` fields deliberately freeze
// process.env at module load; getter-based fields (openaicompat host,
// anthropiccompat auth) deliberately re-read env per request. Do not convert
// between the two styles — the split is load-bearing for env-capture timing.
export const PROVIDERS = {
  deepseek: {
    url: process.env.UPSTREAM_DEEPSEEK || "https://api.deepseek.com",
    host: "api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  kimi: {
    url: process.env.UPSTREAM_KIMI || "https://api.moonshot.ai",
    host: "api.moonshot.ai",
    apiKeyEnv: "KIMI_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  minimax: {
    url: process.env.UPSTREAM_MINIMAX || "https://api.minimax.io",
    host: "api.minimax.io",
    apiKeyEnv: "MINIMAX_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  mimo: {
    url: process.env.UPSTREAM_MIMO || "https://api.xiaomimimo.com",
    host: "api.xiaomimimo.com",
    apiKeyEnv: "MIMO_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  glm: {
    url: process.env.UPSTREAM_GLM || "https://open.bigmodel.cn/api/coding/paas/v4",
    host: "open.bigmodel.cn",
    apiKeyEnv: "GLM_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
    buildUrl(_model, pathParam, queryString) {
      const base = (process.env.UPSTREAM_GLM || "https://open.bigmodel.cn/api/coding/paas/v4")
        .replace(/\/+$/, "");
      const path = String(pathParam || "").replace(/^\/+/, "");
      return `${base}/${path}${queryString || ""}`;
    },
  },
  fireworks: {
    url: process.env.UPSTREAM_FIREWORKS || "https://api.fireworks.ai/inference",
    host: "api.fireworks.ai",
    apiKeyEnv: "FIREWORKS_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
  },
  openaicompat: {
    url: process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com",
    get host() {
      try { return new URL(process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com").hostname; }
      catch { return "api.openai.com"; }
    },
    apiKeyEnv: "OPENAICOMPAT_API_KEY",
    authHeaderName: "authorization",
    authHeaderPrefix: "Bearer ",
    buildUrl(_model, pathParam, queryString) {
      // Normalize the base URL: strip trailing slashes and a trailing /v1
      // so both https://host and https://host/v1 produce /v1/<path> (not /v1/v1/...).
      const raw = (process.env.UPSTREAM_OPENAICOMPAT || "https://api.openai.com").replace(/\/+$/, "");
      const base = raw.replace(/\/v1$/i, "");
      // Responses wire mode: remap chat/completions → responses. Only this
      // path is remapped; /models and other paths pass through unchanged.
      const responsesMode = openaiCompatWireApi() === "responses";
      const remapped = responsesMode && pathParam === "chat/completions" ? "responses" : pathParam;
      return `${base}/v1/${remapped}${queryString || ""}`;
    },
  },
  anthropiccompat: {
    get url() {
      return process.env.UPSTREAM_ANTHROPICCOMPAT || "https://api.anthropic.com";
    },
    get host() {
      try { return new URL(process.env.UPSTREAM_ANTHROPICCOMPAT || "https://api.anthropic.com").hostname; }
      catch { return "api.anthropic.com"; }
    },
    apiKeyEnv: "ANTHROPICCOMPAT_API_KEY",
    get authHeaderName() {
      const mode = (process.env.ANTHROPICCOMPAT_AUTH_MODE || "api-key").trim().toLowerCase();
      return mode === "bearer" ? "authorization" : "x-api-key";
    },
    get authHeaderPrefix() {
      const mode = (process.env.ANTHROPICCOMPAT_AUTH_MODE || "api-key").trim().toLowerCase();
      return mode === "bearer" ? "Bearer " : "";
    },
    get extraHeaders() {
      const mode = (process.env.ANTHROPICCOMPAT_AUTH_MODE || "api-key").trim().toLowerCase();
      return mode === "bearer" ? {} : { "anthropic-version": "2023-06-01" };
    },
    buildUrl(_model, pathParam, queryString) {
      const base = (process.env.UPSTREAM_ANTHROPICCOMPAT || "https://api.anthropic.com")
        .replace(/\/+$/, "");
      const remapped = pathParam === "chat/completions" ? "messages" : pathParam;
      return `${base}/v1/${remapped}${queryString || ""}`;
    },
  },
  azureopenai: {
    apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    authHeaderName: "api-key",
    authHeaderPrefix: "",
    buildUrl(model, pathParam, queryString) {
      // Responses API: model is in request body, not URL path.
      // Path remapped from chat/completions → responses.
      const base = process.env.AZURE_OPENAI_ENDPOINT
        || `https://${process.env.AZURE_FOUNDRY_RESOURCE}.cognitiveservices.azure.com`;
      const version = process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
      const remapped = pathParam === "chat/completions" ? "responses" : pathParam;
      const qs = queryString ? `&${queryString.slice(1)}` : "";
      return `${base}/openai/${remapped}?api-version=${version}${qs}`;
    },
  },
  azureanthropic: {
    apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    authHeaderName: "x-api-key",
    authHeaderPrefix: "",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    buildUrl(model, pathParam, queryString) {
      const base = process.env.AZURE_ANTHROPIC_ENDPOINT
        || `https://${process.env.AZURE_FOUNDRY_RESOURCE}.services.ai.azure.com`;
      // queryString already includes leading "?" — use as-is
      const qs = queryString || "";
      // Remap OpenAI-compatible paths to Anthropic Messages API equivalents.
      // Cursor sends chat/completions — Anthropic expects messages.
      const remapped = pathParam === "chat/completions" ? "messages" : pathParam;
      return `${base}/anthropic/v1/${remapped}${qs}`;
    },
  },
};

export function upstreamApiKey(providerKey) {
  const meta = PROVIDERS[providerKey] ?? PROVIDERS.deepseek;
  return process.env[meta.apiKeyEnv] || "";
}

export function isAzureFoundryKimiEndpoint(base) {
  try {
    const url = new URL(base || "");
    const host = url.hostname.toLowerCase();
    return host.endsWith(".services.ai.azure.com") || host.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function decodedPathCandidates(pathParam) {
  const candidates = [pathParam];
  let current = pathParam;
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      candidates.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return candidates;
}

export function isUnsafeUpstreamPath(pathParam) {
  if (!pathParam) return false;
  for (const candidate of decodedPathCandidates(pathParam)) {
    if (
      candidate.startsWith("/") ||
      candidate.startsWith("\\") ||
      candidate.includes("\\") ||
      candidate.includes("?") ||
      candidate.includes("#") ||
      candidate.includes("\0") ||
      candidate.split("/").includes("..")
    ) {
      return true;
    }
  }
  return false;
}
