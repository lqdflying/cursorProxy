// ─── EdgeOne Pages edge function: legacy /azure-openai/v1/* path ──────────────
// Matches all requests under /azure-openai/v1/... — forces provider to azureopenai.

import { setupCompatibility, rewriteUrl } from "../../_shared/proxy.js";

export async function onRequest(context) {
  setupCompatibility(context);

  const { default: handler } = await import("../../../api/proxy.js");

  const targetUrl = rewriteUrl(context.request, "azureopenai");
  const webRequest = new Request(targetUrl, context.request);

  return handler(webRequest);
}
