// ─── EdgeOne Pages shared edge function logic ───────────────────────────────
// Provides process.env shim, KV binding registration, and URL rewriting.
// Each route handler imports this module before dynamically importing
// api/proxy.js so that process.env is available at proxy module evaluation time.

import { setEdgeOneKvBinding } from "../../api/kv.js";

/** Set up EdgeOne Pages compatibility shim. Call before importing api/proxy.js. */
export function setupCompatibility(context) {
  // Shim process.env — EdgeOne edge functions do not provide Node.js process
  // global by default, but api/proxy.js and api/kv.js reference process.env.
  globalThis.process = { env: context.env || {} };

  // Register EdgeOne KV binding so api/kv.js can use it as its third backend.
  // The binding variable name is configured via EDGEONE_KV_BINDING env var
  // (default: cursorproxy_kv). In EdgeOne, KV namespace bindings are
  // injected as global variables in the edge function runtime.
  const bindingName = (context.env && context.env.EDGEONE_KV_BINDING) || "cursorproxy_kv";
  try {
    if (globalThis[bindingName] != null) {
      setEdgeOneKvBinding(globalThis[bindingName]);
    }
  } catch { /* globalThis unavailable (rare) */ }
}

/** Rewrite incoming URL to the internal proxy format with provider and path query params. */
export function rewriteUrl(req, provider) {
  const url = new URL(req.url);
  // Extract path after /v0/ or /v1/ — e.g. /v1/chat/completions → chat/completions
  const pathMatch = url.pathname.match(/^\/v[01]\/(.+)$/);
  const path = pathMatch ? pathMatch[1] : "";

  url.pathname = "/api/proxy";
  url.searchParams.delete("path");
  url.searchParams.delete("provider");
  if (provider) url.searchParams.set("provider", provider);
  url.searchParams.set("path", path);

  return url.toString();
}
