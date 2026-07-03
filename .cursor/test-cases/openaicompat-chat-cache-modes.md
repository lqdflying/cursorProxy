# OpenAI-Compatible Chat Cache Modes

## Purpose

Validate `openaicompat` Chat Completions cache modes:

- `passthrough`: raw Chat Completions behavior.
- `facade`: raw Chat Completions plus cache-hit usage normalization.
- `remote`: raw Chat Completions plus a stable `prompt_cache_key` for upstream-owned state/cache mapping.

## Environment

Use an OpenAI-compatible Chat Completions gateway that can show the outbound request body or logs cache-hit usage fields.

```bash
OPENAICOMPAT_WIRE_API=chat
OPENAICOMPAT_API_KEY=sk-...
UPSTREAM_OPENAICOMPAT=https://your-gateway.example/v1
```

## Test 1: Passthrough

Set:

```bash
OPENAICOMPAT_CHAT_CACHE_MODE=passthrough
```

Send a normal Cursor prompt through an `openaicompat` model.

Expected:

- Upstream URL is `/v1/chat/completions`.
- Request body keeps `messages`.
- Request body has no proxy-injected `prompt_cache_key`.
- No `PREV_RESP_ID_*`, `CACHE_OAI_RESP_ID`, or `OAI_CHAT_REMOTE_KEY` diagnostics appear.

## Test 2: Facade

Set:

```bash
OPENAICOMPAT_CHAT_CACHE_MODE=facade
```

Send a streaming prompt.

Expected:

- Upstream URL is `/v1/chat/completions`.
- Request body keeps `messages`.
- Request body has `stream_options.include_usage=true` when streaming.
- If the gateway returns raw cache-hit counters such as `usage.cached_tokens` or `usage.prompt_cache_hit_tokens`, cursorProxy exposes them as `usage.prompt_tokens_details.cached_tokens`.
- No `prompt_cache_key`, `previous_response_id`, or `oairesp:` state is injected by cursorProxy.

## Test 3: Remote

Set:

```bash
OPENAICOMPAT_CHAT_CACHE_MODE=remote
```

Send two turns in the same Cursor conversation.

Expected:

- Upstream URL remains `/v1/chat/completions`.
- Request body keeps full Chat `messages`; it is not converted to Responses `input`.
- Request body includes either the client-provided `prompt_cache_key` or a derived `remote_*` key.
- Logs include `OAI_CHAT_REMOTE_KEY source: ...`.
- No `previous_response_id`, message trimming, `PREV_RESP_ID_*`, or `CACHE_OAI_RESP_ID` appears.
- Cache-hit usage normalization behaves the same as `facade`.

## Test 4: Responses Isolation

Set:

```bash
OPENAICOMPAT_WIRE_API=responses
OPENAICOMPAT_CHAT_CACHE_MODE=remote
```

Expected:

- Upstream URL is `/v1/responses`.
- Chat remote `prompt_cache_key` injection does not run.
- Responses-mode behavior remains unchanged: `oairesp:` state chaining may run when KV and upstream support it.
