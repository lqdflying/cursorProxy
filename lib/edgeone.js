import { setEdgeOneKvBinding } from "./kv.js";

/** Set up EdgeOne Pages compatibility shim. Call before importing api/proxy.js. */
export function setupEdgeOneCompatibility(context, extraEnv = {}) {
  // Shim process.env because EdgeOne edge functions do not provide Node.js
  // process globally by default, while the shared proxy reads process.env.
  const env = { ...stringEnv(context.env), ...stringEnv(extraEnv) };
  if (!globalThis.process) {
    globalThis.process = { env };
  } else if (!globalThis.process.env) {
    globalThis.process.env = env;
  } else {
    Object.assign(globalThis.process.env, env);
  }

  // Register EdgeOne KV binding so lib/kv.js can use it as its third backend.
  const bindingName = globalThis.process.env.EDGEONE_KV_BINDING || "cursorproxy_kv";
  try {
    const binding = globalThis[bindingName] ?? context.env?.[bindingName];
    if (binding != null && typeof binding === "object") {
      setEdgeOneKvBinding(binding);
      console.log("[cursorProxy:edgeone]", "KV binding registered:", bindingName);
    } else {
      console.warn("[cursorProxy:edgeone]", "KV binding not found (tried: " + bindingName + ")");
    }
  } catch { /* globalThis unavailable (rare) */ }
}

function stringEnv(env) {
  return Object.fromEntries(
    Object.entries(env || {})
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, String(value)])
  );
}

/** Rewrite incoming URL to the internal proxy format with provider and path query params. */
export function rewriteEdgeOneProxyUrl(req, provider) {
  const url = new URL(req.url);
  // Extract path after the optional provider prefix and /v0/ or /v1/.
  // Main routes:   /v1/chat/completions -> chat/completions
  // Legacy routes: /azure-anthropic/v1/chat/completions -> chat/completions
  //                /deepseek/v1/chat/completions -> chat/completions
  //                /kimi/v1/chat/completions -> chat/completions
  //                /minimax/v1/chat/completions -> chat/completions
  //                /mimo/v1/chat/completions -> chat/completions
  //                /glm/v1/chat/completions -> chat/completions
  //                /openaicompat/v1/chat/completions -> chat/completions
  //                /anthropiccompat/v1/chat/completions -> chat/completions
  const pathMatch = url.pathname.match(/^(?:\/(?:azure-(?:openai|anthropic)|deepseek|kimi|minimax|mimo|glm|fireworks|openaicompat|anthropiccompat))?\/v[01]\/(.+)$/);
  const path = pathMatch ? pathMatch[1] : "";

  url.pathname = "/api/proxy";
  url.searchParams.delete("path");
  url.searchParams.delete("provider");
  if (provider) url.searchParams.set("provider", provider);
  url.searchParams.set("path", path);

  return url.toString();
}
