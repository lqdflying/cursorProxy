import http from "node:http";
import handler from "./api/proxy.js";
import { setKvDriver } from "./api/kv.js";

// ─── Local Redis (Docker) ──────────────────────────────────────────────────
// If REDIS_URL is set, use ioredis for low-latency local cache.
// Falls back to Upstash REST (KV_URL + KV_TOKEN) if not set.
if (process.env.REDIS_URL) {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, enableReadyCheck: false });
  redis.on("error", (err) => console.error("[cursorProxy] redis error:", err.message));
  setKvDriver(redis);
  console.log("[cursorProxy] using local Redis:", process.env.REDIS_URL);
}

const PORT = process.env.PORT || 3000;

// Route table mirrors vercel.json rewrites (legacy paths set provider; unified /v1 uses model-based routing)
const ROUTES = [
  { pattern: /^\/deepseek\/v1\/(.+)$/, provider: "deepseek" },
  { pattern: /^\/kimi\/v1\/(.+)$/, provider: "kimi" },
  { pattern: /^\/minimax\/v1\/(.+)$/, provider: "minimax" },
  { pattern: /^\/v1\/(.+)$/, provider: null },
];

function rewriteUrl(rawUrl, host, protocol) {
  const urlObj = new URL(rawUrl, `${protocol}://${host}`);
  for (const { pattern, provider } of ROUTES) {
    const m = urlObj.pathname.match(pattern);
    if (m) {
      urlObj.pathname = "/api/proxy";
      if (provider) urlObj.searchParams.set("provider", provider);
      urlObj.searchParams.set("path", m[1]);
      return urlObj.toString();
    }
  }
  return urlObj.toString();
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    const protocol =
      req.headers["x-forwarded-proto"]?.split(",")[0].trim() || "http";
    const host =
      req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";

    const targetUrl = rewriteUrl(req.url, host, protocol);

    // Read body into a Buffer
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Build Web API Headers (join any multi-value arrays)
    const headersInit = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headersInit[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    const webRequest = new Request(targetUrl, {
      method: req.method,
      headers: headersInit,
      body: body.length > 0 ? body : null,
    });

    const webResponse = await handler(webRequest);

    const outHeaders = {};
    webResponse.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(webResponse.status, outHeaders);

    console.log(`${req.method} ${req.url} -> ${webResponse.status} (${Date.now() - start}ms)`);

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    }
    res.end();
  } catch (err) {
    console.error("[cursorProxy] server error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Internal server error", type: "server_error" },
        })
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(`[cursorProxy] listening on port ${PORT}`);
});
