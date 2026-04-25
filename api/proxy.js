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

// Strip reasoning_content from messages array in the request body
function stripRequestBody(body) {
  if (!body || !body.messages) return body;
  return {
    ...body,
    messages: body.messages.map((m) => {
      if (!m.reasoning_content) return m;
      const cleaned = { ...m };
      delete cleaned.reasoning_content;
      return cleaned;
    }),
  };
}

export default async function handler(req) {
  const url = new URL(req.url);

  // Reconstruct original path: vercel.json passes it as ?path=
  const originalPath = url.searchParams.get("path");
  const upstreamUrl = UPSTREAM + "/v1/" + (originalPath || "chat/completions");

  const headers = new Headers(req.headers);
  headers.set("host", "api.deepseek.com");
  headers.delete("content-length"); // will be recalculated

  let body = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      const rawBody = await req.json();
      const cleanedBody = stripRequestBody(rawBody);
      body = JSON.stringify(cleanedBody);
    } catch {
      body = await req.text();
    }
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body,
  });

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
