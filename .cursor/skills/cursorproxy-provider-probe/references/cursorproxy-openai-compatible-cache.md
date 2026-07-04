# cursorProxy OpenAI-Compatible Cache Reference

Use this reference when interpreting `.cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs` output.

## Current Runtime Shape

Key files:

- `api/proxy.js`: provider routing, path remap, Responses state chaining, streaming/non-streaming response mapping.
- `lib/models.js`: `OPENAICOMPAT_WIRE_API` resolution and compatible alias routing.
- `lib/openaicompat-cache.js`: `OPENAICOMPAT_CACHE_HIT_MODE`, `OPENAICOMPAT_CHAT_CACHE_MODE`, prompt-cache-key derivation, cache-hit usage normalization.
- `lib/azure-openai.js`: shared Responses sanitizer, content normalization, and Responses-to-Chat mappers.
- `.cursor/test-cases/openaicompat-responses-api.md`: manual Cursor verification for Responses mode.
- `.cursor/test-cases/openaicompat-chat-cache-modes.md`: manual Cursor verification for Chat cache modes.

## Provider Pre-Detection Vs cursorProxy Validation

The probe has two different jobs:

1. **Provider pre-detection**: call the upstream provider's own `/v1` API with a provider-native model ID from `/models`. Do not use cursorProxy aliases such as `compatible-gpt-5.5`; direct providers do not know those aliases and may return misleading 503/404 errors. When the question is whether the provider supports the Responses API, the probe must call direct upstream `/v1/responses` with `--phase upstream-responses`; a Chat Completions request that simulates cursorProxy's boundary is not enough.
2. **cursorProxy validation**: after the provider cache mechanism is understood, point the probe at cursorProxy's public route and verify cursorProxy can produce the same upstream request shape, headers, cache keys, response mapping, and usage normalization.

The tuning decision is mode-selective. A single `openaicompat` deployment should normally choose the best confirmed runtime mode for its upstream provider instead of adapting both Chat and Responses modes:

- Use Chat mode when provider logs confirm Chat Completions cache behavior is best, for example `prompt_cache_key + Session_id` on `/v1/chat/completions`.
- Use Responses mode when provider logs confirm HTTP `previous_response_id` or Responses-specific prompt-cache behavior is best.
- Leave the unselected mode unchanged unless a separate probe shows that mode is also needed. This protects providers that already work with the current Responses path from unrelated Chat-mode tuning.

When a direct upstream host returns HTTP 200 with `text/html` from an `/openaicompat/v1` path, treat it as an API-shape failure. Some providers serve an admin/UI app shell there; it is not a working OpenAI-compatible route. Use the advertised `/v1` API base and native model IDs for upstream pre-detection.

Observed example: `https://api.apikl.ai/v1` accepted `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`, but returned `503 Service temporarily unavailable` for cursorProxy-only `compatible-gpt-5.5`. Setting `PROBE_OPENAICOMPATIBLE_MODEL=gpt-5.5` made the same baseline, parameter, and cache probes succeed.

## cursorProxy Public Boundary

cursorProxy clients normally call Chat Completions:

```text
POST /openaicompat/v1/chat/completions
```

When `OPENAICOMPAT_WIRE_API=responses`, cursorProxy remaps that public Chat request to the upstream Responses API:

```text
upstream POST /v1/responses
```

This means a direct probe of cursorProxy `/responses` is not sufficient to prove the runtime path works. For cursorProxy integration validation, the main probe must call `/chat/completions` and then inspect whether the returned body is Chat-shaped and whether logs show the Responses-mode diagnostics.

For direct upstream provider pre-detection, keep the two API families separate:

- Direct provider Responses API: `--phase upstream-responses`, which calls `/v1/responses`.
- Public Chat-boundary Responses mode: `--phase cache-round --endpoint responses` or `--phase responses-chain`, which calls `/chat/completions` and is only a cursorProxy-style boundary simulation unless the target URL is cursorProxy.
- Provider Chat Completions: `--phase cache-round --endpoint chat` or `--phase chat-cache`, which calls `/chat/completions`.

## Behavior Matrix

| Mode | Public path | Upstream path | Request body state | Cache behavior | Expected diagnostics |
|:---|:---|:---|:---|:---|:---|
| Default Chat | `/openaicompat/v1/chat/completions` | `/v1/chat/completions` | Keeps `messages` | No proxy prompt-key injection, no `oairesp:` state | No `MESSAGES_TO_INPUT`, no `PREV_RESP_ID_*` |
| Chat `facade` | `/openaicompat/v1/chat/completions` | `/v1/chat/completions` | Keeps `messages`; may force `stream_options.include_usage=true` | Normalizes raw cache counters into `usage.prompt_tokens_details.cached_tokens`; no `prompt_cache_key` injection | `OAI_CHAT_CACHE_INCLUDE_USAGE_FORCED`, `OAI_CHAT_CACHE_USAGE` or `OAI_CHAT_CACHE_STREAM_USAGE` when a raw counter is normalized |
| Chat `remote` | `/openaicompat/v1/chat/completions` | `/v1/chat/completions` | Keeps `messages`; preserves or injects `prompt_cache_key` | Upstream owns cache/state mapping; no `previous_response_id`, no trimming, no `oairesp:` state | `OAI_CHAT_REMOTE_KEY`, optional Chat cache usage diagnostics |
| Responses default | `/openaicompat/v1/chat/completions` | `/v1/responses` | Converts `messages` to `input`; maps output back to Chat | KV stores response IDs under `oairesp:`; second turns may use `previous_response_id`; explicit `store:false` opts out | `MESSAGES_TO_INPUT` or `INPUT_CHAIN`, `PREV_RESP_ID_MISS`/`FOUND`, `STREAM_OAI_RESP_ID`, `CACHE_OAI_RESP_ID`, `OAI_STREAM_SUMMARY` |
| Responses `sub2api` | `/openaicompat/v1/chat/completions` | `/v1/responses` | Same as Responses default; may inject `compat_cc_*` `prompt_cache_key` | Adds session anchor to `oairesp:` scope and handles stale/unsupported `previous_response_id` fallback | `OAI_PROMPT_CACHE_KEY_INJECTED`, `OAI_SESSION_ANCHOR`, plus Responses diagnostics |

## ChatHub Probe Mismatches

The ChatHub `chathub-provider-probe` skill does not tally with cursorProxy in these places:

- It probes `/responses` directly as a primary runtime path. cursorProxy's OpenAI-compatible Responses mode is activated by public `/chat/completions` and remapped upstream.
- It assumes ChatHub does not use `previous_response_id`. cursorProxy does use `previous_response_id` in `OPENAICOMPAT_WIRE_API=responses`, with `oairesp:` KV state and stateless fallback for known unsupported gateways.
- It treats `store:true` plus `prompt_cache_key` as ChatHub's current state-cache shape. cursorProxy's default Responses cache is response-ID chaining; `prompt_cache_key` is only an optional routing hint and becomes automatic only in `OPENAICOMPAT_CACHE_HIT_MODE=sub2api` for GPT-5/Codex-like models.
- It does not model cursorProxy Chat cache modes. cursorProxy has `OPENAICOMPAT_CHAT_CACHE_MODE=facade|remote`, both restricted to Chat wire mode.
- It used app/runtime env vars instead of dedicated probe env vars. cursorProxy probes should use `PROBE_OPENAICOMPATIBLE_API_KEY`, `PROBE_OPENAICOMPATIBLE_PROXY_URL`, and explicit `/openaicompat/v1` routes for public-boundary checks.

## Official API Contract

The probe and interpretation are grounded in these official OpenAI docs:

- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state): `previous_response_id` chains Responses state; `store:false` disables storage.
- [Responses API reference](https://developers.openai.com/api/reference/resources/responses/): `previous_response_id`, `prompt_cache_key`, `prompt_cache_retention`, `store`, and `text` are valid Responses create parameters.
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): caching is prefix-based and `prompt_cache_key` is a routing hint; `usage.prompt_tokens_details.cached_tokens` is the standard hit counter.

Provider-compatible gateways can diverge. Treat official docs as the target contract and probe output as provider-specific evidence.

## Cache Signal Rules

Cache-read signals:

- `usage.prompt_tokens_details.cached_tokens`
- `usage.input_tokens_details.cached_tokens`
- `usage.cached_tokens`
- `usage.prompt_cache_hit_tokens`
- `choices[].usage.cached_tokens`
- `usage.cache_read_input_tokens`
- `usageMetadata.cachedContentTokenCount`
- `timings.cache_n`
- camelCase equivalents of the above

Cache-write signals:

- `usage.cache_creation_input_tokens`
- `usage.input_tokens_details.cached_creation_tokens`
- `usage.prompt_tokens_details.cached_creation_tokens`
- `usage.cached_creation_tokens`
- camelCase equivalents of the above

Write signals prove the provider created a cache entry, not that the next request hit it. Dashboard/log confirmation is authoritative for billing.

## Confirmation Loop

Cache probing is bounded and interactive. The probe's job is to find a parameter combination that the provider's API accepts and returns valid output for; cache confirmation comes only from the user checking provider/vendor dashboard logs.

1. For provider pre-detection, run `--phase upstream-responses` to test direct `/v1/responses`. Each strategy runs 6 rounds by default (`--runs 6`): round 1 creates a response, round 2 tests `previous_response_id` chaining, and rounds 3-6 test cache stability. Try parameter combinations one at a time in this order until the API returns valid output:
   - `--strategy prompt-key-session-header`
   - `--strategy plain`
   - `--strategy prompt-key-store-true`
2. After each combination, summarize whether `/responses` accepted the request, whether a `response.id` was returned, which parameters were accepted/rejected, and any cache-read usage fields. If the combination fails, move to the next one. If all combinations fail, record direct `/v1/responses` as `exhausted`.
3. As soon as a combination returns valid output, stop iterating and ask the user to verify the listed request IDs in provider/vendor dashboard logs. Do not mark cache confirmed from API usage alone.
4. Run `--phase cache-round --endpoint responses --runs 6` only for cursorProxy-style public Chat-boundary Responses-mode behavior; it sends `/chat/completions`, not `/responses`.
5. Summarize request IDs, cached-token fields, `hitRate`, `stability`, `stableAfterWarmup`, and `intermittentHit` for the request family just tested.
6. Stop and ask the user to verify provider dashboard/logs. Check cursorProxy logs too only when the target is cursorProxy.
7. If the user confirms the Chat-boundary Responses-mode probe, lock it with `--confirmedResponseStrategy` and then start Chat in a separate round.
8. If the user cannot find a cache hit, continue the next strategy for the same request family. Do not start Chat until direct Responses and Chat-boundary Responses are confirmed, exhausted, or intentionally skipped.
9. After the required Responses-family checks are confirmed or exhausted, run Chat Completions strategies one round at a time, with a provider-log verification pause after each round.

Do not mark a cache strategy confirmed from API usage alone. Usage fields are evidence; provider/vendor dashboard/logs are the decision point. cursorProxy logs are the decision point only for cursorProxy integration validation.

Stability terms:

- `stable-after-warmup`: every later round after the first request reported cache-read tokens.
- `intermittent`: at least one later round reported cache-read tokens, but not every later round did.
- `not-observed`: no later round reported cache-read tokens.
- `not-measured`: there were not enough rounds to evaluate post-warm-up stability.

If multiple strategies are run sequentially without a user confirmation pause, later strategies may be warmed by earlier rounds. Treat those results as non-isolated and rerun the candidate strategy in a fresh bounded round before calling it confirmed.

## What To Check In Logs

For Responses mode:

```text
REQ POST /openaicompat/v1/chat/completions provider: openaicompat
MESSAGES_TO_INPUT provider: openaicompat ...
INPUT_CHAIN provider: openaicompat ...
PREV_RESP_ID_MISS key: conv:<sha>
PREV_RESP_ID_FOUND key: conv:<sha> id: resp_<id>
STREAM_OAI_RESP_ID id: resp_<id>
CACHE_OAI_RESP_ID key: conv:<sha> id: resp_<id>
OAI_PROMPT_CACHE_KEY_INJECTED model: ... key: compat_cc_...
OAI_SESSION_ANCHOR source: ...
OAI_PREV_RESP_UNSUPPORTED_RETRY status: 400 inputItems: <n>
OAI_PREV_RESP_NOT_FOUND_RETRY status: 404 inputItems: <n>
OAI_STREAM_SUMMARY reason: ...
```

For Chat cache modes:

```text
OAI_CHAT_CACHE_INCLUDE_USAGE_FORCED provider: openaicompat ...
OAI_CHAT_REMOTE_KEY provider: openaicompat source: ...
OAI_CHAT_CACHE_USAGE provider: openaicompat cached_tokens: <n>
OAI_CHAT_CACHE_STREAM_USAGE provider: openaicompat cached_tokens: <n>
```

Negative signs:

```text
PREV_RESP_ID_FOUND count: 0 across multiple same-conversation turns
/v1/v1/responses
previous_response_not_found returned to client instead of retried
previous_response_id is only supported on Responses WebSocket v2 returned to client instead of retried
OAI_STREAM_ERROR ... invalid_enum_value ... Invalid value: 'text'
Chat cache mode logs plus PREV_RESP_ID_* in the same request
```

## Recommended Probe Mapping

Use `baseline` to verify routing and auth. For provider pre-detection, use the upstream provider's `/v1` base URL and a provider-native model ID from `/models`. For cursorProxy validation, use cursorProxy's public route after upstream behavior is understood.

Use `upstream-responses` to test the provider's native `/v1/responses` endpoint. This is the direct provider Responses API check. It verifies whether `/responses` works, whether a response ID is exposed, whether `previous_response_id` chaining works, whether `prompt_cache_key` and `Session_id` are accepted for the selected strategy, and whether cache-read usage fields appear.

Use `params` to test the cursorProxy public boundary accepts/remaps:

- `max_tokens` to `max_output_tokens` in Responses mode.
- flat `reasoning_effort` to nested `reasoning.effort`.
- top-level `verbosity` stripping versus `text: { verbosity }`.
- `store:false` opt-out and `store:false + background:true` rejection.

Use `responses-chain` to verify cursorProxy-style public Chat-boundary state or prompt-cache behavior:

- Round 1 should create a response ID.
- Round 2 should include the first assistant turn in the public Chat messages and should rely on cursorProxy to look up and forward `previous_response_id` when the target is cursorProxy.
- If the provider rejects HTTP `previous_response_id` with a known unsupported error, cursorProxy should retry stateless and keep the client response successful.
- `responses-chain --strategy prompt-key-session-header` tests `prompt_cache_key` plus `Session_id` on the public Chat boundary while keeping response-ID state enabled.
- `responses-chain --strategy implicit-derived-key` tests whether cursorProxy/sub2api-style derived `compat_cc_*` keys are enough for GPT/Codex-like models.
- `responses-chain --strategy prompt-key-store-false` verifies the explicit stateless opt-out path.
- `responses-chain --strategy codex-client-metadata` tests `prompt_cache_key`, `Session_id`, and `client_metadata.x-codex-window-id` together for Codex/CLIProxy-style replay session keys.

Use `chat-cache` to characterize Chat Completions cache behavior:

- `chat-session-header-prompt-cache-key`: both `Session_id` and top-level `prompt_cache_key`.
- `chat-session-header`: CLIProxy-style header routing.
- `chat-prompt-cache-key`: OpenAI-style prompt-cache-key routing.
- `chat-repeat`: automatic provider prefix cache with no explicit cache hints.
- `chat-cache-control-content`: late optional check for Anthropic-style gateways exposed behind an OpenAI facade.

Use `cache-round` for interactive bounded probing:

- Test Chat-boundary Responses mode first: `--endpoint responses`. This still calls `/chat/completions`; it does not prove direct provider `/v1/responses`.
- Test Chat later: `--endpoint chat --confirmedResponseStrategy <strategy>`.
- Use `--endpoint responses` or `--endpoint chat` to probe only one unconfirmed mode.
- Use `--confirmedResponseStrategy <strategy>` or `--confirmedChatStrategy <strategy>` to preserve user-confirmed strategies while testing the other mode.

Use `cache-matrix` only when the user explicitly approves non-interactive exhaustion without confirmation pauses. Use `--matrixMode full` to include late non-standard cache-control probes.

Use `upstream-responses` for upstream gateway native `/responses` behavior. It does not prove cursorProxy's public path without the public-boundary probes, and the public-boundary probes do not prove direct `/responses`.

## Runtime Setting Recommendations

Translate confirmed probe results into cursorProxy settings or code changes carefully:

- Default Responses chaining: use `OPENAICOMPAT_WIRE_API=responses`; no cache-hit mode is required when logs confirm `PREV_RESP_ID_FOUND` and `CACHE_OAI_RESP_ID`.
- sub2api-like Responses prompt-cache routing: use `OPENAICOMPAT_WIRE_API=responses` with `OPENAICOMPAT_CACHE_HIT_MODE=sub2api` for GPT/Codex-like models.
- Chat upstream-owned cache/session routing: use `OPENAICOMPAT_WIRE_API=chat` with `OPENAICOMPAT_CHAT_CACHE_MODE=remote`.
- Chat usage/accounting normalization only: use `OPENAICOMPAT_WIRE_API=chat` with `OPENAICOMPAT_CHAT_CACHE_MODE=facade`.
- If provider pre-detection requires both a top-level `prompt_cache_key` and an upstream `Session_id` header, current cursorProxy `remote` mode may be insufficient by itself because it derives/injects `prompt_cache_key` but does not necessarily forward the original session header. Treat that as an implementation gap to verify in `api/proxy.js`.
- Mixed or conflicting needs: state the exact mode split. cursorProxy's cache mode env vars are deployment-wide; they are not a per-provider UI matrix.
