# OpenAI-Compatible Responses API Mode (OPENAICOMPAT_WIRE_API=responses)

## Purpose

Validate that the `openaicompat` provider, when `OPENAICOMPAT_WIRE_API=responses` is set, routes to the upstream OpenAI Responses API (`/v1/responses`), performs `previous_response_id` chaining via KV under the `oairesp:` namespace, maps Responses output/SSE back to Chat Completions, and honors `store:false` opt-out. Also validates that default mode (`chat` / unset) is an unchanged Chat Completions passthrough.

## Provider And Model

- Cursor model: `compatible-gpt-5.6` (alias → `gpt-5.6-sol` upstream)
- Provider route: unified `https://<host>/v1` (alias auto-routes to `openaicompat`) or explicit `https://<host>/openaicompat/v1`
- Deployment: production, Docker, or EdgeOne with `OPENAICOMPAT_API_KEY` set and `OPENAICOMPAT_WIRE_API=responses`
- Cursor mode: agent/chat mode that sends streaming chat completions

## Preconditions

- Required env vars:
  - `OPENAICOMPAT_API_KEY` set to a valid key for an OpenAI-compatible endpoint that supports `/v1/responses` and `store:true`. Endpoints that also support HTTP `previous_response_id` should exercise the cache-hit path; endpoints that reject it with the known WebSocket-only error should exercise Test 7's stateless fallback.
  - `OPENAICOMPAT_WIRE_API=responses`
  - Optional: `OPENAICOMPAT_REASONING_EFFORT=max` to force GPT-5.6 Sol's highest single-model, quality-first effort as nested `reasoning.effort` in Responses mode. GPT-5.5 does not support `max`, so GPT-5.5 requests fall back to `xhigh`. `ultra` is multi-agent orchestration, not an effort value. Expect higher cost and latency; other models or upstreams may reject unsupported effort values.
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
> If `OPENAICOMPAT_REASONING_EFFORT=max` is set with `compatible-gpt-5.6`, logs should also include `REASONING_EFFORT effort: max provider: openaicompat source: openaicompat_env`. If the request resolves to GPT-5.5, the same env should log `REASONING_EFFORT effort: xhigh provider: openaicompat source: openaicompat_env`. `AZURE_OPENAI_REASONING_EFFORT` must not produce that line for `openaicompat`.

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

In Cursor agent mode with `compatible-gpt-5.6` selected, paste this exact prompt:

```text
Dispatch exactly two independent tool calls in parallel in the same assistant turn, and start both calls concurrently:

1. Use Shell directly to run `pwd` in the current workspace. This must be a direct Shell call, not Shell invoked through a subagent.
2. Start one read-only explore subagent that inspects the current workspace and reports the top-level purpose of the project without editing any files.

Do not use Shell through the subagent. Do not run either call before the other; dispatch both together so their tool streams overlap. Wait for both calls to complete, then briefly report both results.
```

Expected behavior:

- The Shell card displays the non-empty `pwd` command, not only `$`, and Shell executes it.
- The read-only explore subagent starts, inspects the workspace without editing, and reports the project's top-level purpose.
- Both calls start from the same assistant turn and both complete.
- Logs may show `functionArgDeltas: <n>` and `content: 0` for a pure tool-call turn; that is valid as long as Cursor executes the tool.
- If the upstream emits a `Subagent` tool call containing local-incompatible cloud keys, the proxy strips only those keys before Cursor sees the final arguments delta.

Expected per-tool diagnostics:

```text
OAI_TOOL_CALL_START provider: openaicompat name: Shell ... toolIndex: 0 ...
OAI_TOOL_CALL_DONE provider: openaicompat name: Shell ... toolIndex: 0 ... argKeys: command,...
OAI_TOOL_CALL_START provider: openaicompat name: Task ... toolIndex: 1 ...
OAI_TOOL_CALL_DONE provider: openaicompat name: Task ... toolIndex: 1 ... argKeys: description,prompt,readonly,subagent_type,...
OAI_TASK_ARGS_SANITIZED provider: openaicompat name: Task ... removed: cloud_base_branch,model,resume ...
OAI_GPT56_TOOL_CHUNKS_REORDERED shellIndex: 0 deferred: <n> reason: shell_done
```

> Exact upstream Responses `output_index` values may vary. The transformed tool calls must still use dense Chat indexes beginning at `0`, and argument ownership must remain separate: Shell arguments belong only to dense `toolIndex: 0`, while Subagent/Task arguments belong only to dense `toolIndex: 1`. For GPT-5.6, the downstream Shell start and complete arguments must be contiguous before Task index `1` chunks; returning from index `1` to a late Shell index `0` continuation is not Cursor-compatible even when each payload reconstructs independently.
>
> GPT-5.6 may populate every optional Task field with empty local defaults. For local execution, the proxy removes `cloud_base_branch` when `environment` is not `cloud` and removes blank `model` / `resume`; it preserves valid local fields such as `environment:"local"` and `file_attachments:[]`. Valid cloud Task arguments remain unchanged.
>
> `OAI_TOOL_CALL_DONE` argument-shape logs establish that the proxy parsed the upstream/model arguments for each tool. They do not by themselves prove that Cursor correctly assembled the transformed downstream stream; confirm the visible Shell command, both tool starts, and both completions in Cursor.

Expected logs for the known local Subagent compatibility path:

```text
OAI_TOOL_CALL_DONE provider: openaicompat name: Subagent ... argKeys: cloud_base_branch,description,environment,file_attachments,...
OAI_SUBAGENT_ARGS_SANITIZED provider: openaicompat name: Subagent ... removed: cloud_base_branch,environment,file_attachments
```

GPT-5.5 compatibility baseline:

1. Select `compatible-gpt-5.5`.
2. Start a fresh Cursor agent-mode conversation and replay the exact prompt above without changes.
3. Require the current working behavior to remain intact: the non-empty Shell command executes, the read-only explore subagent starts, and both calls complete. This is a compatibility baseline; downstream chunk internals do not need to match GPT-5.6 exactly.

Regression signs:

- A blank Shell card showing only `$`.
- A second Shell identity chunk.
- Missing per-index arguments or Shell and subagent arguments cross-contaminated between indexes.
- Downstream tool chunks returning from Task index `1` to a late Shell index `0` continuation.
- Failure to start either tool.
- `OAI_STREAM_SUMMARY ... functionArgDeltas: <n> ... content: 0` combined with Cursor reporting that a tool or subagent failed to start.
- A transformed stream without a terminal Chat chunk containing `finish_reason:"tool_calls"` before `data: [DONE]`.

### Test 10 — Halo MCP discovery with empty filters

Set `OPENAICOMPAT_CACHE_HIT_MODE=halo` for this case.

In Cursor agent mode with `compatible-gpt-5.5` selected and at least one MCP server enabled, start a fresh conversation. Paste this prompt:

```text
Discover the available MCP tools, then tell me the names of the first three tools you can see. Do not call any tool other than the MCP discovery/catalog tool.
```

Expected behavior:

- Cursor discovers MCP tools without a long visible retry loop.
- If the model emits `GetMcpTools` with empty placeholder filters, Cursor still receives a broad catalog request and the MCP tool list eventually appears.
- The response should not need to explain that it is retrying because an empty-argument form is sensitive.

Expected diagnostics when the empty-filter repair path is exercised:

```text
OAI_TOOL_CALL_START provider: openaicompat name: GetMcpTools ...
OAI_TOOL_CALL_DONE provider: openaicompat name: GetMcpTools ... argKeys: server,toolName,pattern
OAI_GET_MCP_TOOLS_ARGS_SANITIZED provider: openaicompat name: GetMcpTools ... removed: server,toolName,pattern argKeys: (none)
OAI_STREAM_SUMMARY reason: response.completed ... functionArgDeltas: <n>
RES 200 provider: openaicompat ms: <n>
```

Baseline preservation check:

- If `GetMcpTools` carries non-empty `server`, `toolName`, or `pattern` filters, those fields must remain present downstream.
- In that filtered case, `OAI_GET_MCP_TOOLS_ARGS_SANITIZED` should not appear for the call.
- With `OPENAICOMPAT_CACHE_HIT_MODE` unset/default or set to `sub2api`, empty `GetMcpTools` filters are not rewritten by this halo-specific repair. Those modes should keep their existing behavior.

Regression signs:

- Cursor repeatedly calls `GetMcpTools` with empty `server`, `toolName`, and `pattern` but never receives a usable catalog.
- Cursor-visible text says it is retrying the catalog request without placeholder fields.
- Production logs show `OAI_TOOL_CALL_DONE provider: openaicompat name: GetMcpTools ... argKeys: server,toolName,pattern` for empty filters without a matching `OAI_GET_MCP_TOOLS_ARGS_SANITIZED` line.
- Non-empty MCP discovery filters are stripped, causing a targeted catalog lookup to turn into an unfiltered lookup.

## Negative signs

```text
PREV_RESP_ID_FOUND count: 0 across multiple turns   # chaining never activated (branch never executed)
UPSTREAM_ERROR_STATUS                                  # upstream rejected the request (check store/previous_response_id/tool fallback)
OAI_STREAM_ERROR ... invalid_enum_value ... Invalid value: 'text'
previous_response_id is only supported on Responses WebSocket v2 # should be retried stateless, not returned to Cursor
previous_response_not_found                            # stale or mismatched response ID replayed against wrong scope
/v1/v1/responses                                       # URL normalization bug — trailing /v1 in UPSTREAM_OPENAICOMPAT not stripped
GetMcpTools empty filters repeatedly reach Cursor without OAI_GET_MCP_TOOLS_ARGS_SANITIZED
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

- The `compatible-gpt-5.6` alias resolves to upstream model `gpt-5.6-sol` and maps the response model back to `cursorproxy/compatible-gpt-5.6`. Verify this with the `COMPATIBLE_ALIAS_RESOLVED alias: compatible-gpt-5.6 upstream: gpt-5.6-sol` log line.
- The upstream endpoint MUST support the OpenAI Responses API (`/v1/responses`, `store:true`) for this mode to work. If the upstream rejects HTTP `previous_response_id` with the known WebSocket-only error, the proxy retries stateless as described in Test 7; other unsupported Responses API errors are surfaced upstream and are not proxy bugs.
- Halo-style Responses mode sends tool-output turns stateless first to avoid the known `previous_response_id` tool-output rejection.
- This is **state chaining** via `previous_response_id`, NOT `OPENAICOMPAT_REASONING_CACHE` (which is Chat-mode-only reasoning injection) and NOT prompt-cache hints.
- Automated coverage lives in `test/openaicompat-wire-api.test.js` (pure helper unit tests) and `test/openaicompat-responses.test.js` (integration tests with mocked fetch + in-memory KV). This manual case verifies the full Cursor → proxy → upstream → Cursor loop end-to-end.
