// ─── EdgeOne Pages edge function: legacy /kimi/v1/* path ─────────────────────
// Matches all requests under /kimi/v1/... — forces provider to kimi.

import { setupCompatibility, rewriteUrl } from "../../_shared/proxy.js";

export async function onRequest(context) {
  setupCompatibility(context);

  const { default: handler } = await import("../../../api/proxy.js");

  const targetUrl = rewriteUrl(context.request, "kimi");
  const webRequest = new Request(targetUrl, context.request);

  return handler(webRequest);
}
