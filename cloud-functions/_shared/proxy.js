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
  const webRequest = await toWebRequest(targetUrl, context.request);
  return handler(webRequest);
}

async function toWebRequest(targetUrl, request) {
  const method = request.method || "GET";
  const init = {
    method,
    headers: new Headers(request.headers || {}),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = await readRequestBody(request);
  }

  return new Request(targetUrl, init);
}

async function readRequestBody(request) {
  if (typeof request.text === "function") {
    return request.text();
  }
  if (typeof request.arrayBuffer === "function") {
    return request.arrayBuffer();
  }
  if (typeof request.json === "function") {
    return JSON.stringify(await request.json());
  }
  if (typeof request.body === "string" || request.body instanceof ArrayBuffer) {
    return request.body;
  }
  if (request.body instanceof Uint8Array) {
    return request.body;
  }
  if (request.body == null) {
    return "";
  }
  return JSON.stringify(request.body);
}
