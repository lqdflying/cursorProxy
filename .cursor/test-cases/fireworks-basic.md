# Fireworks AI — Basic Routing

## Purpose

Validate that `cursorproxy/fireworks/kimi-k2p7-code` routes through Fireworks AI, the model ID is mapped to Fireworks' `accounts/fireworks/models/...` format, streaming works, and existing providers are unaffected.

## Provider And Model

- Cursor model: `cursorproxy/fireworks/kimi-k2p7-code`
- Provider route: `fireworks`
- Deployment: Vercel (or Docker/EdgeOne)
- Cursor mode: Agent

## Preconditions

- `FIREWORKS_API_KEY` set (Fireworks AI API key)
- `CURSORPROXY_API_KEY` set
- `CURSORPROXY_MODELS` includes `fireworks/kimi-k2p7-code` (or is unset)

## Test Steps

### Test 1: Basic coding task via Fireworks

Paste this prompt into Cursor:

```text
Write a Python function that returns the nth Fibonacci number. Keep it under 10 lines.
```

Expected Cursor behavior:

- Returns a short Python function.
- No errors.

Expected Vercel logs (group by `requestId`):

```text
REQ POST /v1/chat/completions provider: fireworks
FIREWORKS_MODEL_RESOLVED bare: fireworks/kimi-k2p7-code upstream: accounts/fireworks/models/kimi-k2p7-code
UPSTREAM https://api.fireworks.ai/inference/v1/chat/completions provider: fireworks
RES 200 provider: fireworks ms: ...
```

Verify:
- `provider: fireworks` in REQ and RES lines (not `kimi`)
- `UPSTREAM` URL points to `api.fireworks.ai` (not `api.moonshot.ai`)
- `FIREWORKS_MODEL_RESOLVED` shows the internal model ID

### Test 2: Streaming passthrough works

Paste this prompt into Cursor in a new chat:

```text
Write a haiku about programming.
```

Expected Cursor behavior:

- Returns a haiku.
- Response model field is `cursorproxy/fireworks/kimi-k2p7-code` (not `accounts/fireworks/models/kimi-k2p7-code`)

Expected Vercel logs:

```text
REQ POST /v1/chat/completions provider: fireworks
...
STREAM_DONE reasoning: ... content: ...
RES 200 provider: fireworks ms: ...
```

### Test 3: No regression — Kimi still works

In a new chat, switch the model to `cursorproxy/kimi-k2.7-code` (no `fireworks/` prefix).

Paste this prompt:

```text
Write a Python function that calculates factorial. Keep it under 8 lines.
```

Expected Cursor behavior:

- Returns a short Python function.
- Routes through the Kimi provider, not Fireworks.

Expected Vercel logs:

```text
REQ POST /v1/chat/completions provider: kimi
KIMI_BODY_SANITIZED model: kimi-k2.7-code ...
UPSTREAM https://api.moonshot.ai/v1/chat/completions provider: kimi
RES 200 provider: kimi ms: ...
```

Verify that `provider: kimi` and no `FIREWORKS_*` diagnostics appear.

### Test 4: Multi-turn reasoning bridge

In a **new** chat with model `cursorproxy/fireworks/kimi-k2p7-code`, paste:

```text
Write a Python function that returns the nth Fibonacci number. Keep it under 10 lines.
```

Then in the **same** chat, paste:

```text
Add memoization to that function.
```

Expected Cursor behavior:

- Updates the prior function with memoization.
- No error about missing `reasoning_content`.

Expected Vercel logs on turn 2:

```text
INJECT_SUMMARY turns: 1 hits: 1 misses: 0 recovered: 0
```

`hits: >= 1` proves cached reasoning was re-injected into the prior assistant turn.

## Negative Signs (bug still present)

- `provider: kimi` when using `cursorproxy/fireworks/kimi-k2p7-code` (prefix not recognized, fell through to Kimi)
- `UPSTREAM_ERROR_STATUS` for any Fireworks request
- `FIREWORKS_MODEL_RESOLVED` does NOT appear (model ID mapping skipped)
- `RES` model field is `accounts/fireworks/models/...` instead of `cursorproxy/fireworks/...`
- `KIMI_BODY_SANITIZED` appears for a Fireworks request (Kimi sanitizer incorrectly applied)
- Existing `cursorproxy/kimi-k2.7-code` routes to Fireworks instead of Kimi
- Turn 2 `INJECT_SUMMARY` shows `hits: 0 misses: 1` (reasoning not re-injected)
- Upstream 400 about missing `reasoning_content` on a multi-turn Fireworks request

## Cleanup

No files should be created. If any test created scratch files, delete them.
