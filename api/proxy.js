export const config = { runtime: "edge" };

const UPSTREAM = "https://api.deepseek.com";

// Strip reasoning_content from a message or delta object
function stripReasoning(obj) {
  if (!obj) return obj;
  const result = { ...obj };
  delete result.reasoning_content;
  return result;
}

// Strip reasoning_content from all choices in a response chunk
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

// Strip reasoning_content from all assistant messages in the request body
function stripRequestBody(bodyText) {
  try {
    const json = JSON.parse(bodyText);
    if (Array.isArray(json.messages)) {
      json.messages = json.messages.map((msg) => {
        if (msg.reasoning_content !== undefined) {
          const { reasoning_content, ...rest } = msg;
          return rest;
        }
        return msg;
      });
    }
    return JSON.stringify(json);
  } catch {
    return bodyText;
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  const upstreamUrl = UPSTREAM + url.pathname + url.search;

  const headers = new Headers(req.headers);
  headers.set("host", "api.deepseek.com");

  // Read and clean the request body
  let body = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await req.text();
    body = stripRequestBody(raw);
    headers.set("content-length", new TextEncoder().encode(body).length.toString());
  }

  const upstreamReq = new Request(upstreamUrl, {
    method: req.method,
    headers,
    body,
  });

  const upstreamRes = await fetch(upstreamReq);

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isStream = contentType.includes("text/event-stream");

  if (!isStream) {
    const json = await upstreamRes.json();
    const stripped = stripResponseChunk(json);
    return new Response(JSON.stringify(stripped), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Streaming: transform SSE line by line
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = upstreamRes.body.getReader();
    let buffer = "";
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
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              continue;
            }
            try {
              const json = JSON.parse(data);
              const stripped = stripResponseChunk(json);
              await writer.write(
                encoder.encode("data: " + JSON.stringify(stripped) + "\n\n")
              );
            } catch {
              await writer.write(encoder.encode(line + "\n\n"));
            }
          } else if (line.trim()) {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
      if (buffer.trim()) {
        await writer.write(encoder.encode(buffer));
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
