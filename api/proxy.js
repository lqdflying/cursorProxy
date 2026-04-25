export const config = { runtime: "edge" };

const UPSTREAM = "https://api.deepseek.com";
const DEBUG = true; // set to false once working

function log(...args) {
  if (DEBUG) console.log("[cursorProxy]", ...args);
}

// Upstash Redis REST API helpers
// Set KV_URL and KV_TOKEN in Vercel environment variables
async function kvGet(key) {
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (!url || !token) {
    log("KV_GET_SKIP: missing env");
    return null;
  }
  try {
    const reqUrl = `${url}/get/${encodeURIComponent(key)}`;
    log("KV_GET_URL:", reqUrl.replace(token, "***"));
    const res = await fetch(reqUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    log("KV_GET_RES:", JSON.stringify(json).substring(0, 500));
    return json.result ?? null;
  } catch (e) {
    log("KV_GET_ERR:", e.message);
    return null;
  }
}

async function kvSet(key, value, ttlSeconds = 7200) {
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (!url || !token) {
    log("KV_SET_SKIP: missing env");
    return;
  }
  try {
    const reqUrl = `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttlSeconds}`;
    log("KV_SET_URL:", reqUrl.replace(token, "***").substring(0, 200));
    const res = await fetch(reqUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    log("KV_SET_RES:", JSON.stringify(json));
  } catch (e) {
    log("KV_SET_ERR:", e.message);
  }
}

async function contentHash(text) {
  const data = new TextEncoder().encode(String(text).substring(0, 2000));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return (
    "rc:" +
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 40)
  );
}

function stripReasoning(obj) {
  if (!obj) return obj;
  const { reasoning_content, ...rest } = obj;
  return rest;
}

function stripResponseChunk(json) {
  if (!json.choices) return json;
  return {
    ...json,
    choices: json.choices.map((c) => ({
      ...c,
      ...(c.message ? { message: stripReasoning(c.message) } : {}),
      ...(c.delta ? { delta: stripReasoning(c.delta) } : {}),
    })),
  };
}

export default async function handler(req) {
  const url = new URL(req.url);
  let pathname = url.pathname;
  const searchParams = new URLSearchParams(url.search);

  log("HANDLER_START req.url:", req.url, "pathname:", pathname);

  // Handle rewritten URL from vercel.json: /api/proxy?path=xxx
  if (pathname === "/api/proxy" || pathname.startsWith("/api/proxy/")) {
    const path = searchParams.get("path");
    if (path) {
      pathname = "/v1/" + path;
      searchParams.delete("path");
      log("RECONSTRUCTED_PATH:", pathname);
    }
  }

  const queryString = searchParams.toString()
    ? "?" + searchParams.toString()
    : "";
  const upstreamUrl = UPSTREAM + pathname + queryString;
  log("UPSTREAM_URL:", upstreamUrl);

  // Parse request body
  let bodyText = "";
  let parsedBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyText = await req.text();
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {}
  }

  // Inject stored reasoning_content into ALL assistant messages missing it
  let injectedCount = 0;
  if (parsedBody?.messages) {
    const messages = parsedBody.messages;
    for (let i = 0; i < messages.length; i++) {
      if (
        messages[i].role === "assistant" &&
        !("reasoning_content" in messages[i])
      ) {
        const assistantContent =
          typeof messages[i].content === "string"
            ? messages[i].content
            : JSON.stringify(messages[i].content);
        const key = await contentHash(assistantContent);
        log(
          "INJECT_TRY idx:",
          i,
          "content_preview:",
          JSON.stringify(assistantContent).substring(0, 80),
          "key:",
          key
        );
        const stored = await kvGet(key);
        if (stored != null) {
          parsedBody.messages[i] = {
            ...messages[i],
            reasoning_content: stored,
          };
          injectedCount++;
          log("INJECT_OK idx:", i, "rc_preview:", stored.substring(0, 80));
        } else {
          log("INJECT_MISS idx:", i);
        }
      }
    }
    bodyText = JSON.stringify(parsedBody);
  }
  log("INJECT_TOTAL:", injectedCount, "of", parsedBody?.messages?.filter(m => m.role === "assistant").length || 0, "assistant msgs");

  const headers = new Headers(req.headers);
  headers.set("host", "api.deepseek.com");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("accept-encoding");
  headers.set("accept-encoding", "identity");

  const upstreamRes = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: bodyText || null,
  });

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isStream = contentType.includes("text/event-stream");
  log("UPSTREAM_STATUS:", upstreamRes.status, "isStream:", isStream);

  if (!isStream) {
    const json = await upstreamRes.json();
    const reasoning = json.choices?.[0]?.message?.reasoning_content;
    const content = json.choices?.[0]?.message?.content;
    log(
      "NONSTREAM_CACHE reasoning_present:",
      reasoning != null,
      "content_preview:",
      JSON.stringify(content).substring(0, 80)
    );
    if (reasoning != null && content != null) {
      const key = await contentHash(content);
      log("NONSTREAM_CACHE_KEY:", key);
      await kvSet(key, reasoning);
    }
    return new Response(JSON.stringify(stripResponseChunk(json)), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Streaming
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = upstreamRes.body.getReader();
    let buffer = "";
    let accReasoning = "";
    let accContent = "";
    let sawDone = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              sawDone = true;
              log(
                "STREAM_DONE_CACHE reasoning_len:",
                accReasoning.length,
                "content_preview:",
                JSON.stringify(accContent).substring(0, 80)
              );
              if (accReasoning.length > 0 || accContent.length > 0) {
                const key = await contentHash(accContent);
                log("STREAM_CACHE_KEY:", key);
                await kvSet(key, accReasoning);
              }
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              continue;
            }
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              if (delta?.reasoning_content) accReasoning += delta.reasoning_content;
              if (delta?.content) accContent += delta.content;
              await writer.write(
                encoder.encode(
                  "data: " + JSON.stringify(stripResponseChunk(json)) + "\n\n"
                )
              );
            } catch {
              await writer.write(encoder.encode(line + "\n\n"));
            }
          } else if (line.trim()) {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } finally {
      // Cache even if [DONE] was not explicitly sent (connection closed)
      if (!sawDone && (accReasoning.length > 0 || accContent.length > 0)) {
        log(
          "STREAM_FINALLY_CACHE reasoning_len:",
          accReasoning.length,
          "content_preview:",
          JSON.stringify(accContent).substring(0, 80)
        );
        const key = await contentHash(accContent);
        log("STREAM_FINALLY_KEY:", key);
        await kvSet(key, accReasoning);
      }
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: upstreamRes.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
