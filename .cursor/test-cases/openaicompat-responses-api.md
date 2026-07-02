# OpenAI-Compatible Responses API Mode (OPENAICOMPAT_WIRE_API=responses)

## Purpose

Validate that the `openaicompat` provider, when `OPENAICOMPAT_WIRE_API=responses` is set, routes to the upstream OpenAI Responses API (`/v1/responses`), performs `previous_response_id` chaining via KV under the `oairesp:` namespace, maps Responses output/SSE back to Chat Completions, and honors `store:false` opt-out. Also validates that default mode (`chat` / unset) is an unchanged Chat Completions passthrough.

## Provider And Model

- Cursor model: `compatible-gpt-5.5` (alias → `gpt-5.5` upstream)
- Provider route: unified `https://<host>/v1` (alias auto-routes to `openaicompat`) or explicit `https://<host>/openaicompat/v1`
- Deployment: production, Docker, or EdgeOne with `OPENAICOMPAT_API_KEY` set and `OPENAICOMPAT_WIRE_API=responses`
- Cursor mode: agent/chat mode that sends streaming chat completions

## Preconditions

- Required env vars:
  - `OPENAICOMPAT_API_KEY` set to a valid key for an OpenAI-compatible endpoint that supports `/v1/responses` and `store:true`. Endpoints that also support HTTP `previous_response_id` should exercise the cache-hit path; endpoints that reject it with the known WebSocket-only error should exercise Test 7's stateless fallback.
  - `OPENAICOMPAT_WIRE_API=responses`
  - Optional: `OPENAICOMPAT_REASONING_EFFORT=xhigh` to force nested `reasoning.effort` for Responses requests.
  - A KV backend configured (`REDIS_URL` for Docker, `KV_URL` + `KV_TOKEN` for Vercel/Upstash, or an EdgeOne KV binding). Without KV, chaining silently degrades to stateless mode.
- Required deployment state: deployed and reachable from Cursor.
- Required files or workspace state: a tiny file under `.cursor/tmp/` for any edit/apply tests (keep prompts low-risk).

## Test Steps

### Test 1 — First turn (stateless write)

Start a fresh conversation. Paste this prompt:

```text
In one sentence, what is the cursorProxy project?
```

Expected Cursor behavior:

- Cursor receives a normal streaming response with the answer.

Expected Vercel logs (Turn 1):

```text
REQ POST /v1/chat/completions provider: openaicompat
MESSAGES_TO_INPUT provider: openaicompat inputItems: 1 prevResp: (none)
PREV_RESP_ID_MISS key: conv:<sha>
STREAM_OAI_RESP_ID id: resp_<id>            # streaming; or CACHE_OAI_RESP_ID for non-streaming
RES 200 provider: openaicompat ms: <n>
```

> The `PREV_RESP_ID_MISS` is expected on the first turn — there is no prior response ID to chain from. The response ID is written to KV under `oairesp:conv:<sha>` after the stream completes.
> If `OPENAICOMPAT_REASONING_EFFORT=xhigh` is set, logs should also include `REASONING_EFFORT effort: xhigh provider: openaicompat source: openaicompat_env`. `AZURE_OPENAI_REASONING_EFFORT` must not produce that line for `openaicompat`.

### Test 2 — Second turn (cache hit, trimmed input)

In the same conversation, follow up:

```text
Summarize that in three words.
```

Expected Cursor behavior:

- Cursor receives a normal streaming response referencing the prior turn.

Expected Vercel logs (Turn 2):

```text
REQ POST /v1/chat/completions provider: openaicompat
PREV_RESP_ID_FOUND key: conv:<sha> id: resp_<id>
MESSAGES_TO_INPUT provider: openaicompat inputItems: 1 prevResp: resp_<id>...
STREAM_OAI_RESP_ID id: resp_<new_id>
RES 200 provider: openaicompat ms: <n>
```

> `PREV_RESP_ID_FOUND` proves the KV lookup resolved against the ID cached in Turn 1. `inputItems: 1` (not the full history) proves the input was trimmed to only the new user message.

### Test 3 — store:false opt-out

Send a request with `store:false` in the body (e.g. via a direct API call, or a client that sets it). This is the privacy/compliance opt-out path.

Expected Vercel logs:

```text
STORE_OPT_OUT provider: openaicompat client sent store:false — chaining disabled (no prev lookup, no KV write)
MESSAGES_TO_INPUT provider: openaicompat inputItems: <n> prevResp: (none)
RES 200 provider: openaicompat ms: <n>
```

> No `PREV_RESP_ID_FOUND` / `PREV_RESP_ID_MISS` should appear — the KV lookup is skipped entirely. No `STREAM_OAI_RESP_ID` / `CACHE_OAI_RESP_ID` write either.

### Test 4 — store:false + background:true rejected

Send a request with both `store:false` and `background:true`.

Expected behavior: HTTP 400 with error type `store_background_conflict`.

Expected Vercel logs:

```text
STORE_BACKGROUND_CONFLICT provider: openaicompat store:false + background:true is incompatible
```

### Test 5 — Default mode (WIRE_API unset) is Chat Completions passthrough

With `OPENAICOMPAT_WIRE_API` unset (or `=chat`), send any prompt.

Expected Vercel logs:

```text
REQ POST /v1/chat/completions provider: openaicompat
RES 200 provider: openaicompat ms: <n>
```

> None of the Responses-mode diagnostics (`MESSAGES_TO_INPUT`, `INPUT_CHAIN`, `STREAM_OAI_RESP_ID`, `PREV_RESP_ID_*`) should appear. The upstream URL must be `/v1/chat/completions`, not `/v1/responses`.

### Test 6 — Mixed tool compatibility retry

In Cursor agent mode, use a prompt that exposes the normal tool set. Some OpenAI-compatible Responses gateways reject requests that mix many function tools with a native Responses `custom` `apply_patch` tool.

Expected behavior:

- If the first upstream request succeeds, no fallback log is required.
- If the first upstream request returns a 5xx for the mixed tool shape, the proxy retries once and Cursor should still receive a normal response.

Expected fallback log when the retry path is exercised:

```text
TOOLS_SHAPE provider: openaicompat total: <n> ... chatCmplFmt: <n> ... knownType: 1
APPLY_PATCH_TOOL_SHAPE provider: openaicompat custom: 1
OAI_TOOL_FALLBACK_RETRY status: 502 droppedNative: 1 functionTools: <n>
RES 200 provider: openaicompat ms: <n>
```

> The retry omits native `custom`/`apply_patch` tools only after the upstream rejects the richer mixed Responses tool request. Existing function tools are preserved.

### Test 7 — HTTP previous_response_id unsupported fallback

In the same conversation, send a second turn after a successful first turn. Some OpenAI-compatible gateways return a `resp_*` ID on turn 1 but reject HTTP `previous_response_id` on turn 2 with `previous_response_id is only supported on Responses WebSocket v2`.

Expected behavior:

- Cursor receives a normal response after one stateless retry.
- The retried upstream request sends the full input array and no `previous_response_id`.
- Later turns in the same process skip response-ID chaining for that upstream/model/user scope.

Expected logs when this path is exercised:

```text
PREV_RESP_ID_FOUND key: conv:<sha> id: resp_<id>
OAI_PREV_RESP_UNSUPPORTED_RETRY status: 400 inputItems: <full_count>
RES 200 provider: openaicompat ms: <n>
```

Expected later log for the same scope:

```text
OAI_PREV_RESP_UNSUPPORTED_SKIP provider: openaicompat mode: stateless
MESSAGES_TO_INPUT provider: openaicompat inputItems: <full_count> prevResp: (none)
```

> This means the gateway supports Responses mode but not Codex-style HTTP `previous_response_id` cache chaining. The proxy downgrades to stateless Responses so Cursor keeps working.

### Test 8 — Structured text content normalization

Continue the same Cursor conversation after at least one assistant turn. Cursor may send prior assistant or user text as structured content arrays such as `[{ "type": "text", "text": "..." }]` instead of plain strings.

Expected behavior:

- Cursor receives a normal response.
- The upstream stream must not return an `invalid_enum_value` error for `content[0].type = "text"`.

Expected log when this path is exercised:

```text
OAI_INPUT_NORMALIZED provider: openaicompat textParts: <n>
RES 200 provider: openaicompat ms: <n>
```

> Plain string content must remain a string for openaicompat Responses mode. Only existing structured `text` parts are rewritten to Responses-legal `input_text` / `output_text`.

### Test 9 — Tool/subagent stream mapping

In Cursor agent mode, ask for a task that causes the model to call a tool or start a subagent.

Expected behavior:

- Cursor starts/runs the requested tool or subagent instead of reporting a tool-start failure.
- Logs may show `functionArgDeltas: <n>` and `content: 0` for a pure tool-call turn; that is valid as long as Cursor executes the tool.
- If the upstream emits a `Subagent` tool call containing local-incompatible cloud keys, the proxy strips only those keys before Cursor sees the final arguments delta.

Regression signs:

```text
OAI_STREAM_SUMMARY ... functionArgDeltas: <n> ... content: 0
```

combined with Cursor UI reporting that a tool/subagent failed to start. In that case inspect the transformed downstream SSE: Responses `output_index` values must be remapped to dense Chat `tool_calls[].index` values starting at `0`, and the stream must include a terminal Chat chunk with `finish_reason:"tool_calls"` before `data: [DONE]`.

Expected logs for the known local Subagent compatibility path:

```text
OAI_TOOL_CALL_DONE provider: openaicompat name: Subagent ... argKeys: cloud_base_branch,description,environment,file_attachments,...
OAI_SUBAGENT_ARGS_SANITIZED provider: openaicompat name: Subagent ... removed: cloud_base_branch,environment,file_attachments
```

## Negative signs

```text
PREV_RESP_ID_FOUND count: 0 across multiple turns   # chaining never activated (branch never executed)
UPSTREAM_ERROR_STATUS                                  # upstream rejected the request (check store/previous_response_id/tool fallback)
OAI_STREAM_ERROR ... invalid_enum_value ... Invalid value: 'text'
previous_response_id is only supported on Responses WebSocket v2 # should be retried stateless, not returned to Cursor
previous_response_not_found                            # stale or mismatched response ID replayed against wrong scope
/v1/v1/responses                                       # URL normalization bug — trailing /v1 in UPSTREAM_OPENAICOMPAT not stripped
```

## KV key stability cross-check

After two sessions, export production logs and confirm `PREV_RESP_ID_FOUND` keys resolve against previously-emitted `CACHE_OAI_RESP_ID` keys:

```bash
# Note: logs emit the UNPREFIXED hash key (conv:<sha>). The oairesp:/azresp:
# prefix is applied only at the kvGet/kvSet call sites, not in diag output.
comm -23 \
  <(rg 'PREV_RESP_ID_FOUND key: conv:[a-f0-9]+' log.txt | sort -u) \
  <(rg 'CACHE_OAI_RESP_ID key: conv:[a-f0-9]+' log.txt | sort -u)
# Empty output = all lookups resolved against previously cached keys
```

> Note: the underlying KV key is `oairesp:conv:<sha>`, distinct from Azure's `azresp:conv:<sha>`. The two providers' response IDs must never collide, but the diag logs show only the shared `conv:<sha>` hash (the namespace is disambiguated by the `provider:` field in `REQ`/`RES`, not by the logged key).

## Cleanup

- Remove any `.cursor/tmp/` files created during testing.
- Optionally disable `OPENAICOMPAT_WIRE_API` after testing to restore default Chat Completions mode.

## Notes

- The `compatible-gpt-5.5` alias resolves to upstream model `gpt-5.5` and maps the response model back to `cursorproxy/compatible-gpt-5.5`. Verify this with the `COMPATIBLE_ALIAS_RESOLVED` log line.
- The upstream endpoint MUST support the OpenAI Responses API (`/v1/responses`, `store:true`) for this mode to work. If the upstream rejects HTTP `previous_response_id` with the known WebSocket-only error, the proxy retries stateless as described in Test 7; other unsupported Responses API errors are surfaced upstream and are not proxy bugs.
- This is **state chaining** via `previous_response_id`, NOT `OPENAICOMPAT_REASONING_CACHE` (which is Chat-mode-only reasoning injection) and NOT prompt-cache hints.
- Automated coverage lives in `test/openaicompat-wire-api.test.js` (pure helper unit tests) and `test/openaicompat-responses.test.js` (integration tests with mocked fetch + in-memory KV). This manual case verifies the full Cursor → proxy → upstream → Cursor loop end-to-end.
