// EdgeOne Pages Cloud Function wrapper.
// Log Analysis currently shows Cloud Functions logs, so these entry points
// keep the proxy behavior but run it through the Node.js function runtime.

import {
  setupEdgeOneCompatibility,
  rewriteEdgeOneProxyUrl,
} from "../../api/edgeone.js";

export async function handleProxyRequest(context, provider) {
  setupEdgeOneCompatibility(context, { EDGEONE_CLOUD_FUNCTION: "true" });

  const { default: handler } = await import("../../api/proxy.js");
  const targetUrl = rewriteEdgeOneProxyUrl(context.request, provider);
  const webRequest = new Request(targetUrl, context.request);
  return handler(webRequest);
}
