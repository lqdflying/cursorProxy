// EdgeOne Pages Edge Function wrapper.
// Pages KV bindings are currently available to Edge Functions, so API routes
// that need reasoning/response-id/image caches enter through this runtime.

import {
  setupEdgeOneCompatibility,
  rewriteEdgeOneProxyUrl,
} from "../../api/edgeone.js";

export async function handleProxyRequest(context, provider) {
  setupEdgeOneCompatibility(context, { EDGEONE_EDGE_FUNCTION: "true" });

  const { default: handler } = await import("../../api/proxy.js");
  const targetUrl = rewriteEdgeOneProxyUrl(context.request, provider);
  const webRequest = toWebRequest(targetUrl, context.request);
  return handler(webRequest);
}

function toWebRequest(targetUrl, request) {
  const method = request.method || "GET";
  const init = {
    method,
    headers: new Headers(request.headers || {}),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    if (isReadableStream(init.body)) {
      // Node-based local runtimes require this for streaming request bodies.
      init.duplex = "half";
    }
  }

  return new Request(targetUrl, init);
}

function isReadableStream(value) {
  return value && typeof value.getReader === "function";
}

export {
  setupEdgeOneCompatibility as setupCompatibility,
  rewriteEdgeOneProxyUrl as rewriteUrl,
};
