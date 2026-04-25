export const config = { runtime: "edge" };

const UPSTREAM = "https://api.deepseek.com";

// Upstash Redis REST API helpers
// Set KV_URL and KV_TOKEN in Vercel environment variables
async function kvGet(key) {
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function kvSet(key, value, ttlSeconds = 7200) {
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(
      `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?ex=${ttlSeconds}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {}
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
  const upstreamUrl = UPSTREAM + url.pathname + url.search;

  // Parse request body
  let bodyText = "";
  let parsedBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    bodyText = await req.text();
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {}
  }

  // Inject stored reasoning_content into last assistant message
  if (parsedBody?.messages) {
    const messages = parsedBody.messages;
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (
      lastAssistantIdx !== -1 &&
      !("reasoning_content" in messages[lastAssistantIdx])
    ) {
      const assistantContent =
        typeof messages[lastAssistantIdx].content === "string"
          ? messages[lastAssistantIdx].content
          : JSON.stringify(messages[lastAssistantIdx].content);
      const key = await contentHash(assistantContent);
      const stored = await kvGet(key);
      if (stored) {
        parsedBody.messages[lastAssistantIdx] = {
          ...messages[lastAssistantIdx],
          reasoning_content: stored,
        };
      }
    }
    bodyText = JSON.stringify(parsedBody);
  }

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

  if (!isStream) {
    const json = await upstreamRes.json();
    const reasoning = json.choices?.[0]?.message?.reasoning_content;
    const content = json.choices?.[0]?.message?.content;
    if (reasoning && content) {
      const key = await contentHash(content);
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
              if (accReasoning && accContent) {
                const key = await contentHash(accContent);
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
