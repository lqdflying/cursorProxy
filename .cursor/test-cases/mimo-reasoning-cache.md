# MiMo Multi-Turn Reasoning Bridge

## Purpose

Verify the proxy caches MiMo `reasoning_content` in KV and re-injects it into prior assistant messages on the next turn so upstream does not return 400 for missing reasoning on thinking-mode follow-ups.

## Provider And Model

- Cursor model: `mimo-v2.5-pro`
- Provider route: unified `https://<host>/v1`
- Deployment: production or Docker with KV + `MIMO_API_KEY`

## Preconditions

- Required env vars: `CURSORPROXY_API_KEY`, `MIMO_API_KEY`, plus one KV backend (`KV_URL`+`KV_TOKEN`, `REDIS_URL`, or EdgeOne KV binding)
- Same Cursor chat thread for both turns (do not start a new composer between steps)

## Test Steps

**Turn 1** — paste:

```text
Think carefully, then answer: what is the capital of France? Reply with the city name only.
```

Wait for the full response to finish (streaming complete).

**Turn 2** — in the same thread, paste:

```text
Now name one famous landmark in that city. One phrase only.
```

Expected Cursor behavior:

- Turn 2 succeeds without upstream 400 about missing `reasoning_content` on prior assistant messages.
- Visible answers are sensible (`Paris` / a landmark); reasoning text is not shown in the UI.

Expected Vercel logs:

**Turn 1** (same `requestId`):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: mimo
[cursorProxy:proxy] THINKING provider: mimo type: enabled
[cursorProxy:proxy] RES 200 provider: mimo
```

With `DEBUG=true`, after stream completes:

```text
[cursorProxy:reasoning] INJECT_SUMMARY turns: <n> hits: 0 misses: <n> recovered: 0
```

(and/or cache write diagnostics for reasoning snapshot)

**Turn 2** (new `requestId`, same conversation):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: mimo
[cursorProxy:proxy] THINKING provider: mimo type: enabled
[cursorProxy:proxy] INJECT_SUMMARY turns: 1 hits: 1 misses: 0 recovered: 0
[cursorProxy:proxy] RES 200 provider: mimo
```

`INJECT_SUMMARY` with `hits: 1` proves reasoning was re-injected from KV on an immediate cache hit. `INJECT_RECOVERED` only appears when a retry was needed (`recovered: 1`); that is a valid but rarer path.

With `DEBUG=true`, also expect `[cursorProxy:reasoning] INJECT_SUMMARY` with the same counts.

Negative signs:

```text
INJECT_MISS missed: 1
(reasoning_content is required)
UPSTREAM_STATUS 400
```

## Cleanup

None

## Notes

- If turn 2 shows `INJECT_MISS` or no `INJECT_SUMMARY` with `hits: 1`, check KV availability (`/health` → `kv.available: true`) and that both turns used the same `CURSORPROXY_API_KEY` scope.
