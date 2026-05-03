// ─── EdgeOne Pages edge function: unified /v0/* path (model-based routing) ──
// Matches all requests under /v0/... including /v0/models, etc.

import { setupCompatibility, rewriteUrl } from "../_shared/proxy.js";

export async function onRequest(context) {
  // Must be called before api/proxy.js is imported because proxy.js reads
  // process.env at module evaluation time (PROVIDERS map defaults).
  setupCompatibility(context);

  const { default: handler } = await import("../../api/proxy.js");

  // Provider is intentionally null — proxy.js infers it from the model field
  const targetUrl = rewriteUrl(context.request, null);
  const webRequest = new Request(targetUrl, context.request);

  return handler(webRequest);
}
