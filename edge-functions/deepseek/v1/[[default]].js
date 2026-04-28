// ─── EdgeOne Pages edge function: legacy /deepseek/v1/* path ─────────────────
// Matches all requests under /deepseek/v1/... — forces provider to deepseek.

import { setupCompatibility, rewriteUrl } from "../../_shared/proxy.js";

export async function onRequest(context) {
  setupCompatibility(context);

  const { default: handler } = await import("../../../api/proxy.js");

  const targetUrl = rewriteUrl(context.request, "deepseek");
  const webRequest = new Request(targetUrl, context.request);

  return handler(webRequest);
}
