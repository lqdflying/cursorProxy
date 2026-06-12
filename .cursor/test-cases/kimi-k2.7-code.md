# Kimi K2.7 Code Support

## Purpose

Validate that `kimi-k2.7-code` requests are sanitized for Moonshot API
constraints, reasoning is cached and re-injected across turns, and multi-step tool
calls do not fail on missing `reasoning_content`.

## Provider And Model

- Cursor model: `cursorproxy/kimi-k2.7-code` (or bare `kimi-k2.7-code`)
- Provider route: `kimi`
- Cursor mode: Agent

## Preconditions

- `KIMI_API_KEY` set (Moonshot API key)
- `CURSORPROXY_API_KEY` set
- KV configured (`REDIS_URL`, `KV_URL` + `KV_TOKEN`, or EdgeOne KV binding)
- `CURSORPROXY_MODELS` includes `kimi-k2.7-code` (or is unset)

## Test Steps

### Test 1: Basic coding task (turn 1)

Paste this prompt into Cursor:

```text
Write a Python function that returns the nth Fibonacci number. Keep it under 15 lines.
```

Expected Cursor behavior:

- Returns a short Python function.
- No upstream 400 mentioning `temperature`, `thinking`, or sampling params.

Expected logs (group by `requestId`):

```text
REQ POST /v1/chat/completions provider: kimi
KIMI_BODY_SANITIZED model: kimi-k2.7-code thinkingType: (omitted) toolChoice: auto maxTokens: (unset)
RES 200 provider: kimi ms: ...
```

Verify `thinkingType: (omitted)` — K2.7 Code must not forward a `thinking` field.

### Test 2: Multi-turn follow-up (reasoning bridge)

In the **same** chat, paste:

```text
Add memoization to that function.
```

Expected Cursor behavior:

- Updates the prior function with memoization.
- No error about missing `reasoning_content`.

Expected logs on turn 2:

```text
INJECT_SUMMARY turns: 1 hits: 1 misses: 0 recovered: 0
```

`hits: >= 1` proves cached reasoning was re-injected into the prior assistant turn.

### Test 3: Tool loop (within-turn reasoning round-trip)

Start a **new** chat. Paste:

```text
List the files in the project root directory using your file tools. Reply with just the filenames.
```

Expected Cursor behavior:

- Agent invokes a file-listing tool and returns filenames.
- No upstream 400 about `reasoning_content` missing during tool-call follow-up requests.

Expected logs across the tool-loop `requestId` group:

```text
KIMI_BODY_SANITIZED model: kimi-k2.7-code ...
INJECT_SUMMARY turns: ... hits: ... misses: ...
RES 200 provider: kimi ms: ...
```

## Negative Signs (bug still present)

- Upstream 400 mentioning `temperature`, `top_p`, `n`, `presence_penalty`, or `frequency_penalty`
- Upstream 400 mentioning `thinking` or `disabled`
- Upstream 400: `reasoning_content` missing in assistant message during tool calls
- Turn 2 `INJECT_SUMMARY` shows `hits: 0 misses: 1` with KV configured (cache miss regression)
- `CONVERTED_IMAGES` appears for a text-only Kimi request (vision bridge should not run)

## Cleanup

No files should be created. If Test 3 created scratch files under `.cursor/tmp/`, delete them.
