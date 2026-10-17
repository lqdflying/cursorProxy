# DeepSeek V4.1 Flash Default Model

## Purpose

Validate that DeepSeek requests route to the `deepseek` provider, the retired default (`deepseek-chat`) is no longer injected, `deepseek-flash` is injected when the client omits the model, DeepSeek thinking and `reasoning_effort` are forced, images reach Flash natively and V4 Pro uses the vision bridge, and multi-turn reasoning reuse works through the `deepseek:<user>` KV scope.

This also guards against regression of the 2026-07-24 retirement: requests that omit `model` must reach `api.deepseek.com` with `model: deepseek-flash`, not the dead `deepseek-chat` alias.

## Provider And Model

- Cursor model: omit `model` to exercise default injection, or set `cursorproxy/deepseek-flash` (or bare `deepseek-flash`)
- Provider route: unified `https://<host>/v1` and legacy `https://<host>/deepseek/v1`
- Deployment: Vercel (production) for log verification; Docker and EdgeOne also supported
- Cursor mode: Agent or Chat that sends streaming chat completions

## Preconditions

- Required env vars: `CURSORPROXY_API_KEY`, `DEEPSEEK_API_KEY`
- Optional: `CURSORPROXY_MODELS` includes `deepseek-flash` for `GET /v1/models` discovery
- Optional upstream override: `UPSTREAM_DEEPSEEK=https://api.deepseek.com` (default)
- KV backend configured for multi-turn reasoning-reuse checks
- Vision backend configured (default MiniMax VL-01 reusing `MINIMAX_API_KEY`, or `VISION_API_PROVIDER=openai`) for image-attachment checks

## Test Steps

### Test 1: Default-model injection (model omitted)

Cursor normally sends a model ID. Exercise omission with the handler replay in `test/model-refresh.test.js`, or a direct request to `/deepseek/v1/chat/completions` with no model. For the closest Cursor check, select Flash and paste:

```text
Think step by step privately, then answer in one sentence: write a JavaScript function named add42 that returns its numeric argument plus 42.
```

Expected Cursor behavior:

- The model answers with a small JavaScript function or equivalent explanation.
- No raw `reasoning_content` is visible in Cursor.

Expected Vercel logs (same `requestId` group, always-on):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: deepseek
[cursorProxy:proxy] RES 200 provider: deepseek ms: <number>
```

With `DEBUG=true`, also expect:

```text
[cursorProxy:proxy] MODEL_INJECTED model: deepseek-flash
[cursorProxy:proxy] RESOLVED model: deepseek-flash provider: deepseek stream: true
[cursorProxy:proxy] UPSTREAM https://api.deepseek.com/v1/chat/completions provider: deepseek
[cursorProxy:proxy] UPSTREAM_STATUS 200 provider: deepseek stream: true
```

The `MODEL_INJECTED` line MUST show `deepseek-flash`. If it shows `deepseek-chat`, the retired default is still in `api/proxy.js` and DeepSeek will return an upstream model-not-found error on subsequent turns.

### Test 2: Thinking injection and reasoning effort (default high)

Same prompt as Test 1, with `model` set explicitly to `cursorproxy/deepseek-flash`.

Expected Vercel logs (always-on):

```text
[cursorProxy:proxy] THINKING provider: deepseek reasoning_effort: high raw_env: (unset)
```

The forwarded body MUST contain `thinking: { type: "enabled" }` and `reasoning_effort: "high"`. Cursor-visible behavior is unchanged; this is a wire-level check (use `UPSTREAM_REQUEST_DUMP` to inspect metadata only, never request bodies).

### Test 3: `DEEPSEEK_REASONING_EFFORT=max` env override

Set `DEEPSEEK_REASONING_EFFORT=max` in the deployment env, redeploy, and replay Test 1. Expected logs:

```text
[cursorProxy:proxy] THINKING provider: deepseek reasoning_effort: max raw_env: max
```

The forwarded body MUST use `max`. The env value wins over any client-supplied effort.

### Test 4: Invalid `DEEPSEEK_REASONING_EFFORT` falls back safely

Set `DEEPSEEK_REASONING_EFFORT=turbo` (typo) and replay Test 1. Expected logs:

```text
[cursorProxy:proxy] THINKING_INVALID_EFFORT provider: deepseek raw_env: turbo fallback: high valid: low|high|max
[cursorProxy:proxy] THINKING provider: deepseek reasoning_effort: high raw_env: turbo
```

The forwarded body MUST use `high` (the safe default), not `turbo`. DeepSeek must NOT return a 400.

### Test 5: Multi-turn reasoning cache reuse (tools-aware interleaved semantics)

DeepSeek V4's reasoning-passback rule is keyed on the request carrying the `tools` parameter, per the official `thinking_mode` docs: *"for requests carrying the `tools` parameter, the `reasoning_content` must be fully passed back to the API in all subsequent requests. If your code does not correctly pass back `reasoning_content`, the API will return a 400 error."* This is per-request and unbounded — it spans across new user messages and covers tool-call assistant turns anywhere in the history, including rounds before the last user message (the doc's Turn-2 sample proves retention across a new user message). The proxy therefore disables the interleaved optimization entirely for native deepseek when the request carries `tools` (full-history injection: cached reasoning or the placeholder). Between two `user` messages with no tool call, reasoning is ignored by the API, so the skip is only a safe latency optimization for the **no-tools** shape.

#### Test 5a: No-tools user-ending follow-up — injection skipped (optimization)

In Cursor **chat mode with no tools configured** (or a client that does not send the `tools` parameter), paste:

```text
Explain the differences between REST and GraphQL in one paragraph.
```

Then immediately follow up with:

```text
Now give me a concrete example of a use case where GraphQL is clearly better.
```

> [!WARNING]
> Cursor's chat mode may still send a `tools` array. Before relying on 5a's "no `INJECT_SUMMARY`" expectation, confirm via `UPSTREAM_REQUEST_DUMP` (metadata only) or the captured upstream body that the second turn's request body has no `tools` field (or an empty one). If `tools` is present, this turn is a 5b shape, not a 5a shape — see 5b.

Expected Cursor behavior:

- The second response references the first response's context without re-explaining REST vs GraphQL from scratch.

Expected Vercel logs (always-on, second turn, no-tools shape):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: deepseek
[cursorProxy:proxy] RES 200 provider: deepseek ms: <number>
```

No `INJECT_SUMMARY` line should appear for this turn — the request is user-ending with no `tools`, so the proxy intentionally skips reasoning injection (`userEndingInterleaved` gate in `api/proxy.js`). The absence of `INJECT_SUMMARY` here is correct only for the no-tools shape, not a KV failure. Do not chase a phantom KV bug if this line is missing for no-tools user-ending follow-ups.

#### Test 5b: Tools-carrying agent multi-turn — injection required on every turn (including user-ending)

Trigger an agent flow in Cursor agent mode (which always sends `tools`). First do a tool round, then send a follow-up user prompt. For example:

```text
Read .cursor/test-cases/TEMPLATE.md and summarize its sections in one sentence.
```

Wait for the tool round to complete, then send a new user follow-up:

```text
Now list the section headings only.
```

Expected Vercel logs (always-on, the follow-up user turn and every tool-ending sub-turn):

```text
[cursorProxy:proxy] INJECT_SUMMARY turns: <number> hits: <number> misses: <number> recovered: <number>
```

`INJECT_SUMMARY` MUST appear on the **user-ending agent follow-up** too (because the request carries `tools`), and `hits`/`misses` must cover assistant turns from **earlier closed tool rounds before the last user message**, not only turns after the last user message. The captured upstream body for such a turn must carry `reasoning_content` (cached or the `"(prior reasoning unavailable)"` placeholder) on every prior tool-call assistant turn. If `INJECT_SUMMARY` is absent on a tools-carrying user-ending turn, or only covers turns after the last user message, the tools-aware gate has regressed and DeepSeek will return a 400. If `hits` is 0 across multiple sessions for tools-carrying turns despite successful prior turns, the cache scope key derivation may have regressed (it should remain `deepseek:<apiKeyHash>`).

### Test 6: Native Flash images and text-only Pro bridging

Paste a small screenshot using `deepseek-flash`:

```text
Describe what is shown in this image in one sentence.
```

Expect a description and `RES 200 provider: deepseek ms: <number>` in the same request group. There must be no `CONVERTED_IMAGES` event for Flash. Repeat with `deepseek-v4-pro`; now expect:

```text
[cursorProxy:proxy] CONVERTED_IMAGES ok: 1 err: 0 provider: deepseek visionMs: <number>
```

The official API's legacy `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` aliases also receive native images. Custom endpoints retain their previous bridge behavior for these IDs. The automated handler suite verifies both routes without calling a live provider.

### Test 7: Legacy `/deepseek/v1` route coverage

Repeat Test 1 against `https://<host>/deepseek/v1/chat/completions`. Expected logs:

```text
[cursorProxy:proxy] REQ POST /deepseek/v1/chat/completions provider: deepseek
[cursorProxy:proxy] RES 200 provider: deepseek ms: <number>
```

The route must reach the same `deepseek` provider and forward to `https://api.deepseek.com/v1/chat/completions`. No new routing surface is required for `deepseek-flash` — it routes by the `deepseek` name prefix.

Expected file/content changes, if any:

- None. None of the prompts above create files.

Negative signs:

```text
MODEL_INJECTED model: deepseek-chat            # retired default still present in api/proxy.js
UPSTREAM https://api.deepseek.com/v1/chat/completions model: deepseek-chat
UPSTREAM_ERROR_STATUS 404                      # DeepSeek returns model-not-found for the retired alias
UPSTREAM_STATUS 404
UPSTREAM_STATUS 400                             # upstream rejected a misspelled reasoning_effort
THINKING reasoning_effort: turbo               # invalid env leaked to upstream instead of falling back
UPSTREAM_STATUS 400 (tools-carrying request)    # missing reasoning_content on a prior tool-call assistant turn
                                                # — dominant failure mode; hits user-ending agent follow-ups
                                                #   and tool-ending turns alike, including rounds before the
                                                #   last user message
INJECT_SUMMARY absent (tools-carrying turn)     # tools-aware isInterleaved gate regressed -> 400 follows
INJECT_SUMMARY hits: 0 (tools-carrying turn)     # KV scope regressed or KV backend down for required-injection turns
```

## Cleanup

None. No files are created by these prompts.

## Notes

- `deepseek-flash` is the canonical V4.1 Flash ID. The base URL and bearer authentication are unchanged; the proxy uses Chat Completions with thinking enabled.
- `deepseek-chat` and `deepseek-reasoner` were retired upstream on 2026-07-24 and are now inaccessible. The proxy default must be `deepseek-flash`; the legacy names still route by prefix but 404 upstream.
- DeepSeek reasoning uses `reasoning_content` (string), accumulated as a single growing string in `lib/stream-pump.js`. Cache scope is `deepseek:<apiKeyHash>` (shared across DeepSeek model variants by design, to preserve existing KV entries).
- Reasoning injection is gated by `deepseek` in `reasoningProviders` (`lib/reasoning.js`). DeepSeek gets the `"(prior reasoning unavailable)"` placeholder on KV miss (it is NOT in the hit-only set used for `glm`/`fireworks`/`openaicompat`). Per the official DeepSeek V4 `thinking_mode` docs, the passback rule is keyed on the request carrying the `tools` parameter: tools-carrying requests must fully pass back `reasoning_content` in ALL subsequent requests (400 on missing), spanning new user messages and covering tool-call assistant turns anywhere in the history — the proxy therefore disables the interleaved optimization for native deepseek when `tools` is present and injects for the full history. Between two `user` messages with no tool call (no-tools shape), reasoning is ignored, so the skip is a safe latency optimization only for that shape.
- Flash uses native images; V4 Pro uses the bridge. Repeat the effort override test with `low`, which is now supported.
- Upstream docs: [DeepSeek API](https://api-docs.deepseek.com)
