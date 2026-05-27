# MiMo Basic Chat + Thinking Injection

## Purpose

Validate unified `/v1` routing to Xiaomi MiMo (`mimo-v2.5-pro`), forced `thinking: { type: "enabled" }` injection, upstream URL construction, and `reasoning_content` stripped from the client-visible response.

## Provider And Model

- Cursor model: `mimo-v2.5-pro` (or `cursorproxy/mimo-v2.5-pro` if using discovery prefix)
- Provider route: unified `https://<host>/v1`
- Deployment: production or Docker with `MIMO_API_KEY` set
- Cursor mode: any chat/agent mode that sends streaming chat completions

## Preconditions

- Required env vars: `CURSORPROXY_API_KEY`, `MIMO_API_KEY`
- Optional: `CURSORPROXY_MODELS` includes `mimo-v2.5-pro` for discovery
- KV backend configured (Upstash, Redis, or EdgeOne KV) for multi-turn reasoning tests (not required for this single-turn case)

## Test Steps

Paste this prompt into Cursor:

```text
Think step by step, then answer in one sentence: what is 17 + 25?
```

Expected Cursor behavior:

- Model responds with `42` (or equivalent) in visible assistant content only — no raw `reasoning_content` block shown in the UI.

Expected file/content changes, if any:

- None

Expected Vercel logs (same `requestId` group, always-on):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: mimo
[cursorProxy:proxy] THINKING provider: mimo type: enabled
[cursorProxy:proxy] RES 200 provider: mimo ms: <number>
```

With `DEBUG=true`, also expect:

```text
[cursorProxy:proxy] START POST ... pathname: /v1/chat/completions provider(query): (infer)
[cursorProxy:proxy] RESOLVED model: mimo-v2.5-pro provider: mimo stream: true
[cursorProxy:proxy] UPSTREAM https://api.xiaomimimo.com/v1/chat/completions provider: mimo
[cursorProxy:proxy] UPSTREAM_STATUS 200 provider: mimo
```

Negative signs:

```text
UNKNOWN_PROVIDER ... provider: mimo
Missing environment variable MIMO_API_KEY
UPSTREAM_ERROR_STATUS
UPSTREAM_STATUS 400
UPSTREAM_STATUS 503
```

## Cleanup

None

## Notes

- Official API: https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api
- Legacy path `/mimo/v1/chat/completions` should produce the same `provider: mimo` logs with `?provider=mimo` set by the rewrite.
