// ─── EdgeOne Pages edge function: legacy /azure-anthropic/v1/* path ────────────
// Matches all requests under /azure-anthropic/v1/... — forces provider to azureanthropic.

import { setupCompatibility, rewriteUrl } from "../../_shared/proxy.js";

export async function onRequest(context) {
  setupCompatibility(context);

  const { default: handler } = await import("../../../api/proxy.js");

  const targetUrl = rewriteUrl(context.request, "azureanthropic");
  const webRequest = new Request(targetUrl, context.request);

  return handler(webRequest);
}
