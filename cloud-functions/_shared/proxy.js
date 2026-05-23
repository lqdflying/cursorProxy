// EdgeOne Pages Cloud Function wrapper.
// Log Analysis shows Cloud Functions logs, so these entry points keep the proxy
// behavior but run it through the Node.js function runtime. Cloud Functions also
// receive the Pages KV binding, so reasoning/response-id/image caches work here.

import {
  setupEdgeOneCompatibility,
  rewriteEdgeOneProxyUrl,
} from "../../api/edgeone.js";

function edgeOneLog(...args) {
  console.log("[cursorProxy:edgeone]", ...args);
}

function edgeOneError(...args) {
  console.error("[cursorProxy:edgeone]", ...args);
}

export async function handleProxyRequest(context, provider) {
  const start = Date.now();
  const { method, url } = context.request;
  const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();

  edgeOneLog("REQ", method, path, provider || "(auto)");

  try {
    setupEdgeOneCompatibility(context, { EDGEONE_CLOUD_FUNCTION: "true" });

    const kvAvailable = (await import("../../api/kv.js")).resolveEdgeOneKv() != null;
    if (kvAvailable) edgeOneLog("KV ready");

    const { default: handler } = await import("../../api/proxy.js");
    const targetUrl = rewriteEdgeOneProxyUrl(context.request, provider);
    const webRequest = await toWebRequest(targetUrl, context.request);
    const response = await handler(webRequest);

    const elapsed = Date.now() - start;
    edgeOneLog("RES", response.status, `${elapsed}ms`);
    return response;
  } catch (err) {
    const elapsed = Date.now() - start;
    edgeOneError("ERROR", method, path, `${elapsed}ms`, err?.message || err);
    return new Response(
      JSON.stringify({ error: { message: "internal proxy error", type: "internal_error" } }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
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
