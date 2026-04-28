// ─── EdgeOne Pages edge function: legacy /minimax/v1/* path ──────────────────
// Matches all requests under /minimax/v1/... — forces provider to minimax.

import { setupCompatibility, rewriteUrl } from "../../_shared/proxy.js";

export async function onRequest(context) {
  setupCompatibility(context);

  const { default: handler } = await import("../../../api/proxy.js");

  const targetUrl = rewriteUrl(context.request, "minimax");
  const webRequest = new Request(targetUrl, context.request);

  return handler(webRequest);
}
