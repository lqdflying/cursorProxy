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
    init.body = await requestBody(request);
    if (isReadableStream(init.body)) {
      // Node's fetch implementation requires this when constructing a Request
      // with a streaming body. EdgeOne ignores unknown RequestInit fields.
      init.duplex = "half";
    }
  }

  return new Request(targetUrl, init);
}

async function requestBody(request) {
  if (isReadableStream(request.body)) {
    return request.body;
  }
  if (typeof request.body === "string" || request.body instanceof ArrayBuffer) {
    return request.body;
  }
  if (request.body instanceof Uint8Array) {
    return request.body;
  }
  if (typeof request.arrayBuffer === "function") {
    return request.arrayBuffer();
  }
  if (typeof request.text === "function") {
    return request.text();
  }
  if (typeof request.json === "function") {
    return JSON.stringify(await request.json());
  }
  if (request.body == null) {
    return "";
  }
  return JSON.stringify(request.body);
}

function isReadableStream(value) {
  return value && typeof value.getReader === "function";
}
