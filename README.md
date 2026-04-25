# DeepSeek Reasoning Proxy

A lightweight Vercel Edge Function that proxies requests to the DeepSeek API. It **caches `reasoning_content` from responses and injects it back into subsequent requests**, enabling multi-turn conversations with `deepseek-reasoner` in clients like Cursor that don't handle the field natively.

## Why

DeepSeek's reasoning models return a `reasoning_content` field alongside `content` in each response. On the next turn, the API **requires** you to pass that `reasoning_content` back inside the assistant message. If you don't, you get a 400 error:

```
{"error": {"message": "The reasoning_content in the thinking mode must be passed back to the API."}}
```

Clients like Cursor strip or ignore `reasoning_content`, so they never send it back. This proxy:

1. **Removes** `reasoning_content` from responses before returning them to Cursor (so Cursor doesn't choke on it)
2. **Caches** the `reasoning_content` keyed by the message content hash
3. **Injects** the cached `reasoning_content` into *all* assistant messages in the request before forwarding to DeepSeek

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/lqdflying/cursorProxy)

Or manually:

1. Fork / clone this repo
2. Import into [Vercel](https://vercel.com) — zero configuration needed
3. Deploy

## Usage

Configure your client to point at the Vercel deployment:

| Field | Value |
|---|---|
| Base URL | `https://<your-vercel-domain>.vercel.app/v1` |
| API Key | Your DeepSeek API key (`sk-...`) |
| Model | `deepseek-reasoner` or `deepseek-chat` |

The proxy forwards your API key directly to DeepSeek — no keys are stored on Vercel.

## Optional: Add a Proxy Token

By default, anyone who knows your Vercel URL can use it to consume your DeepSeek quota. To restrict access:

1. Add an environment variable in Vercel: `PROXY_TOKEN=<your-secret>`
2. Update `api/proxy.js` to validate the token:

```js
const auth = req.headers.get("authorization") || "";
if (auth !== "Bearer " + process.env.PROXY_TOKEN) {
  return new Response("Unauthorized", { status: 401 });
}
```

3. Set your client's API Key to `<your-secret>` instead of the DeepSeek key, and add the real DeepSeek key as `DEEPSEEK_API_KEY` in Vercel environment variables.

## How It Works

```
Cursor  →  Vercel Edge Function  →  api.deepseek.com
                 ↓
      caches reasoning_content on response
      injects reasoning_content on request
      strips reasoning_content before returning to Cursor
```

- Supports both streaming (`text/event-stream`) and non-streaming responses
- Parses each SSE chunk, removes `reasoning_content` from `delta` / `message`, and caches it
- On every request, walks through **all** assistant messages and injects any missing `reasoning_content`
- Built on the [Vercel Edge Runtime](https://vercel.com/docs/functions/edge-functions) — no cold start penalty

## Files

```
api/proxy.js    Edge Function — core proxy logic
vercel.json     Rewrites /v1/* to /api/proxy
package.json    Minimal package descriptor
```

## License

MIT
