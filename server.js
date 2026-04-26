import http from "node:http";
import handler from "./api/proxy.js";

const PORT = process.env.PORT || 3000;

// Route table mirrors vercel.json rewrites
const ROUTES = [
  { pattern: /^\/v1\/(.+)$/, provider: "deepseek" },
  { pattern: /^\/deepseek\/v1\/(.+)$/, provider: "deepseek" },
  { pattern: /^\/kimi\/v1\/(.+)$/, provider: "kimi" },
  { pattern: /^\/minimax\/v1\/(.+)$/, provider: "minimax" },
];

function rewriteUrl(rawUrl, host, protocol) {
  const urlObj = new URL(rawUrl, `${protocol}://${host}`);
  for (const { pattern, provider } of ROUTES) {
    const m = urlObj.pathname.match(pattern);
    if (m) {
      urlObj.pathname = "/api/proxy";
      urlObj.searchParams.set("provider", provider);
      urlObj.searchParams.set("path", m[1]);
      return urlObj.toString();
    }
  }
  return urlObj.toString();
}

const server = http.createServer(async (req, res) => {
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
