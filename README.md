# DeepSeek Reasoning Proxy

A lightweight Vercel Edge Function that proxies requests to the DeepSeek API. It **caches `reasoning_content` by conversation position and injects it back into subsequent requests**, enabling multi-turn conversations with `deepseek-reasoner` in clients like Cursor that don't handle the field natively.

## Why

DeepSeek's reasoning models (`deepseek-reasoner`) return a `reasoning_content` field alongside `content` in each response. On the next turn, the API **requires** you to pass that `reasoning_content` back inside the assistant message. If you don't, you get a 400 error:

```
{"error": {"message": "The reasoning_content in the thinking mode must be passed back to the API."}}
```

Clients like Cursor strip or ignore `reasoning_content`, so they never send it back. This proxy:

1. **Removes** `reasoning_content` from responses before returning them to Cursor (so Cursor doesn't choke on it)
2. **Caches** the `reasoning_content` keyed by conversation position (SHA256 of all messages *before* the assistant reply)
3. **Injects** the cached `reasoning_content` into *all* assistant messages in the request before forwarding to DeepSeek

## Why conversation-position hashing?

Cursor may send assistant message `content` as a structured array `[{"type":"text","text":"..."}]` instead of a plain string. A content-hash cache would never match. The conversation prefix (all messages before the assistant reply) is identical on both sides regardless of content format, so position-based hashing is robust.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/lqdflying/cursorProxy)

Or manually:

1. Fork / clone this repo
2. Import into [Vercel](https://vercel.com)
3. Add environment variables in Vercel:
   - `KV_URL` — your Upstash Redis REST URL
   - `KV_TOKEN` — your Upstash Redis REST token
4. Deploy

## Usage

Configure your client to point at the Vercel deployment:

| Field | Value |
|---|---|
| Base URL | `https://<your-vercel-domain>/v1` |
| API Key | Your DeepSeek API key (`sk-...`) |
| Model | `deepseek-reasoner` or `deepseek-chat` |

The proxy forwards your API key directly to DeepSeek — no keys are stored on Vercel.

## Optional: Lock the proxy with a Proxy Token

By default, anyone who discovers your proxy URL can use it to consume your DeepSeek quota (because the proxy forwards whatever `Authorization` header the client sends).

To restrict access, you need to **move your DeepSeek key to Vercel** and use a separate proxy token in Cursor:

1. Add these environment variables in Vercel:
   - `PROXY_TOKEN=<your-secret>` (a random string you make up)
   - `DEEPSEEK_API_KEY=sk-...` (your real DeepSeek key)

2. Update `api/proxy.js` — replace the header forwarding section with:

```js
// Validate proxy token from client
const auth = req.headers.get("authorization") || "";
if (auth !== "Bearer " + process.env.PROXY_TOKEN) {
  return new Response("Unauthorized", { status: 401 });
}

// Replace with real DeepSeek key before forwarding
const headers = new Headers(req.headers);
headers.set("Authorization", "Bearer " + process.env.DEEPSEEK_API_KEY);
headers.set("host", "api.deepseek.com");
headers.delete("content-length");
headers.delete("transfer-encoding");
headers.delete("accept-encoding");
headers.set("accept-encoding", "identity");
```

3. In Cursor, set your **API Key** to the `PROXY_TOKEN` value instead of the DeepSeek key.

**Note:** This is optional. If you skip it, keep your DeepSeek key in Cursor and the proxy will forward it directly (no `DEEPSEEK_API_KEY` env var needed).

## How It Works

```
Cursor  →  Vercel Edge Function  →  api.deepseek.com
                 ↓
      on response: cache reasoning_content by conversation position
      on request:  inject cached reasoning_content into all assistant msgs
      before return: strip reasoning_content so Cursor stays happy
```

- Supports both streaming (`text/event-stream`) and non-streaming responses
- Caches `reasoning_content` even when the stream ends without an explicit `[DONE]` line
- Built on the [Vercel Edge Runtime](https://vercel.com/docs/functions/edge-functions) — no cold start penalty

## Files

```
api/proxy.js    Edge Function — core proxy logic
vercel.json     Rewrites /v1/* to /api/proxy
package.json    Minimal package descriptor
```

## License

MIT
