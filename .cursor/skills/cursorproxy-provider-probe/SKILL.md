---
name: cursorproxy-provider-probe
description: Probe OpenAI-compatible provider cache behavior before integrating it into cursorProxy, then map confirmed findings to cursorProxy settings or code changes. Use when testing provider cache hits, prompt_cache_key or Session_id behavior, cached-token usage mapping, Responses state chaining, OPENAICOMPAT_WIRE_API=responses, OPENAICOMPAT_CACHE_HIT_MODE=sub2api, or OPENAICOMPAT_CHAT_CACHE_MODE=facade|remote.
---

# cursorProxy Provider Probe

## Workflow

Use this skill for live, low-cost pre-detection of an OpenAI-compatible provider's API and cache-hit behavior, then for deciding how cursorProxy should be configured or changed to use that provider accurately. This skill is provider-agnostic: each probe targets an unknown gateway, so never assume a single provider's behavior generalizes. Never print API keys. If a key was pasted in chat, remind the user to rotate it.

This skill has two stages:

1. **Provider pre-detection**: point `PROBE_OPENAICOMPATIBLE_PROXY_URL` at the upstream provider's own `/v1` base URL and use the provider's native model IDs from `/models`. This stage is independent of cursorProxy routing and must not use cursorProxy-only aliases such as `compatible-gpt-5.5`.
2. **cursorProxy integration validation**: after a cache strategy is observed and user/dashboard-confirmed at the provider, configure cursorProxy and verify that cursorProxy forwards the same required shape, headers, cache keys, response mapping, and usage mapping.

The decision after probing is **mode-selective**. Do not adapt both Chat and Responses modes for one provider by default. Treat each OpenAI-compatible deployment as choosing one best runtime mode from probe evidence:

- If Chat Completions cache is dashboard-confirmed with `prompt_cache_key + Session_id`, recommend `OPENAICOMPAT_WIRE_API=chat` and `OPENAICOMPAT_CHAT_CACHE_MODE=remote`; preserve existing Responses behavior for other providers.
- If HTTP `previous_response_id` is dashboard/log-confirmed and stable, recommend `OPENAICOMPAT_WIRE_API=responses` with default response-ID chaining.
- If Responses prompt-cache routing works without reliable response-ID chaining, recommend `OPENAICOMPAT_WIRE_API=responses` with `OPENAICOMPAT_CACHE_HIT_MODE=sub2api` only when the provider's best confirmed strategy is actually Responses-mode.
- Add code changes only for the selected mode's missing wire shape. Do not broaden a provider-specific workaround into the other mode unless a separate probe confirms that mode needs it.

1. Read `references/cursorproxy-openai-compatible-cache.md` and `references/backend-cache-mechanisms.md` before interpreting probe output.
2. Confirm the environment variables exist:
   - `PROBE_OPENAICOMPATIBLE_API_KEY`: the dedicated test API key for this probe target.
   - `PROBE_OPENAICOMPATIBLE_PROXY_URL`: the dedicated test base URL, expected to include `/v1`. For provider pre-detection this should usually be the upstream provider's own `/v1` base URL. For cursorProxy integration validation, use the cursorProxy public route, for example `http://localhost:3000/openaicompat/v1` or `https://host/openaicompat/v1`, only after upstream behavior is understood.
   - Optional but strongly recommended: `PROBE_OPENAICOMPATIBLE_MODEL`, the provider-native model ID selected from `/models`. The script default is `gpt-5.5` as a convenience for known GPT-5-compatible gateways, but the correct model is provider-specific.
   Do not use the deployment's normal cursorProxy or upstream provider env vars for this skill; these `PROBE_*` vars are intentionally dedicated to live provider diagnostics. When probing a direct upstream, do not use `compatible-*` model aliases because those are cursorProxy aliases, not provider model IDs.
3. Run the baseline provider probe:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase baseline
   ```
4. Run parameter and shape checks:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase params
   ```
5. For provider pre-detection, test the provider's native Responses API. This is the only phase that calls direct upstream `/v1/responses`. Each strategy runs 6 rounds by default (`--runs 6`). Round 1 creates a response, round 2 tests `previous_response_id` chaining, and rounds 3-6 test cache stability. Try parameter combinations one at a time until the API returns valid output. Do not declare cache confirmed at this point; a successful API response only proves the parameter combination is accepted.
   - First combination: `prompt_cache_key` plus `Session_id` header:
     ```bash
     node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase upstream-responses --strategy prompt-key-session-header --runs 6
     ```
   - If that fails, try plain `previous_response_id` chaining:
     ```bash
     node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase upstream-responses --strategy plain --runs 6
     ```
   - If that fails, try `prompt_cache_key` with `store:true`:
     ```bash
     node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase upstream-responses --strategy prompt-key-store-true --runs 6
     ```
   After each attempt, summarize whether `/responses` accepted the request, whether a `response.id` was returned, which parameters were accepted/rejected, and any cache-read usage fields. Stop iterating as soon as the API returns valid output for a combination, then pause for the user to confirm cache behavior from the provider/vendor dashboard logs.
6. If no direct upstream `/responses` combination returns valid output, record that the provider's HTTP Responses API is unsupported or requires different parameters, and stop the Responses-family probing for this provider. Do not proceed to Chat-boundary Responses mode or Chat Completions cache probing for Responses-specific questions.
7. If a direct upstream `/responses` combination returns valid output, do not mark cache as confirmed. Instead, report the request IDs and usage fields and ask the user to check the provider/vendor dashboard logs for those IDs. Only after the user confirms a cache hit (or confirms no hit) do you record the strategy status.
8. For cursorProxy integration validation, or for simulating cursorProxy's public Chat-to-Responses boundary against a direct upstream, use the bounded confirmation loop below. This phase still calls `/chat/completions`; do not describe it as a direct upstream `/responses` test. Run one public Chat-boundary Responses-mode cache round, then stop for user/provider-dashboard confirmation:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint responses --responseStrategy prompt-key-session-header --runs 6
   ```
   Summarize `cacheSummary.responses` and `cacheSummary.round`, then pause and ask the user to check provider dashboard/logs for the request IDs before trying another strategy. Also ask for cursorProxy logs only when the target URL is a cursorProxy route.
9. If the user confirms the Chat-boundary Responses-mode cache hit, lock the confirmed Responses strategy and then test Chat Completions in a separate round:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint chat --chatStrategy chat-session-header-prompt-cache-key --confirmedResponseStrategy prompt-key-session-header --runs 6
   ```
   Stop again and ask the user to verify the Chat request IDs in provider logs before calling Chat confirmed.
10. If the user cannot find a provider cache hit for the current Chat-boundary Responses-mode strategy, do not proceed to Chat. Retest that boundary with the next strategy in the Responses strategy order. If the user later cannot find a provider cache hit for the current Chat strategy, retest Chat with the next strategy in the Chat strategy order. Continue one strategy per round with a verification pause after each round.
11. Test Responses-mode state chaining through the Chat Completions boundary when needed:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase responses-chain
    ```
12. Test Chat cache strategies only after direct upstream `/responses` and the Chat-boundary Responses-mode path are confirmed or intentionally skipped/exhausted:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase chat-cache --strategy chat-session-header-prompt-cache-key
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase chat-cache --strategy chat-session-header
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase chat-cache --strategy chat-prompt-cache-key
    ```
13. If direct upstream `/responses` needs a different target than `PROBE_OPENAICOMPATIBLE_PROXY_URL`, override with `--upstream-base-url` and `--upstream-api-key`, then run:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase upstream-responses --runs 6
    ```
14. After provider pre-detection is complete, provide a concise provider report. Use the script's `providerReport` field first, then explain findings in human-readable form and state the cursorProxy follow-up: current env settings that can express the strategy, or the code gap when cursorProxy cannot yet forward a required field/header.

## Confirmation Loop

Use provider dashboard/log confirmation as the decision point for upstream cache-hit behavior. Use cursorProxy logs only for the later integration-validation stage. API usage fields are evidence, not the final answer. The probe's job is to find a parameter combination that the provider's API accepts and returns valid output for; the user's dashboard confirms whether that combination actually produced cache hits.

- Cache testing is round-bounded. A round is one selected strategy for one request family, with `--runs 6` by default. Do not test Responses and Chat Completions in the same assistant turn unless the user explicitly asks to skip confirmation pauses.
- After every API-successful round, stop and ask the user whether the provider dashboard/logs show cache hits for the listed request IDs. If the target was cursorProxy, also ask for cursorProxy diagnostics. Do not mark a strategy confirmed from API usage alone.
- Maintain separate cache status for direct upstream Responses API, Chat-boundary Responses mode, and Chat Completions request families: `unconfirmed`, `api-accepted-needs-dashboard-check`, `confirmed-intermittent`, `confirmed-stable`, or `exhausted`.
- When API usage shows cache-read tokens for a mode, pause and ask the user to verify that mode's request IDs in provider logs before marking the strategy confirmed.
- Direct upstream Responses API must be tested before Chat Completions during provider pre-detection. The Chat-boundary Responses-mode probe (`cache-round --endpoint responses`) is separate and still sends `/chat/completions`.
- If the user confirms direct upstream Responses or Chat-boundary Responses works, keep that strategy as the correct approach for that request family. Do not keep retesting it unless the user asks. Then test Chat Completions in a separate round only after the required Responses-family checks are confirmed or intentionally skipped/exhausted.
- If the user cannot find the cache hit in provider logs, treat that strategy as unconfirmed and run the next strategy for the same request family. Do not switch request families until the current family is confirmed or exhausted.
- Do not report stable cache detection as complete for a request family until that family is user-confirmed stable, or until every applicable strategy for that family has been tested and exhausted. The overall provider report remains incomplete until both families are confirmed or exhausted.
- A single dashboard-confirmed hit proves the mechanism can work, but not that it is stable. If only some later rounds hit, mark the mode `confirmed-intermittent`, name the confirmed request ID and cached-token count, and recommend a fresh stability round with the same strategy and more runs.
- If every later round after the first warm-up request hits, mark the mode `confirmed-stable`.
- If a strategy intermittently hits, do not reject it. Repeat it with a fresh key before calling it stable or before comparing it against later fallback strategies.

Use `upstream-responses` for direct provider `/v1/responses` checks. Each strategy runs 6 rounds by default: round 1 creates a response, round 2 tests `previous_response_id` chaining, and rounds 3-6 test cache stability with the same cache hints:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase upstream-responses --strategy prompt-key-session-header --runs 6
```

Use `cache-round` for each interactive Chat-boundary round. `--endpoint responses` means cursorProxy-style public Chat-to-Responses behavior and still sends `/chat/completions`; pass it explicitly for clarity:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint responses --responseStrategy prompt-key-session-header --runs 6
```

When validating a dashboard-confirmed but intermittent strategy, rerun only that same mode and strategy with a fresh generated key and more rounds:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint responses --responseStrategy prompt-key-session-header --runs 6
```

In summaries, report `hitRate`, `stability`, `stableAfterWarmup`, and `intermittentHit` from `cacheSummary`. Explain that the first request is a warm-up candidate and the expected stable pattern is that every later request reports cache-read tokens. If only one later request hits, call it intermittent even when the user confirms that one request in the dashboard.

The standard direct upstream Responses strategy order is `prompt-key-session-header`, `plain`, then `prompt-key-store-true` unless the script adds more direct `/responses` strategies. The standard Chat-boundary Responses-mode strategy order is `prompt-key-session-header`, `plain`, `implicit-derived-key`, `prompt-key-store-true`, `prompt-key-store-false`, `session-header-only`, `codex-client-metadata`, then `cache-control-content-blocks` only as a late non-standard probe. The standard Chat Completions strategy order is `chat-session-header-prompt-cache-key`, `chat-session-header`, `chat-prompt-cache-key`, then `chat-repeat`.

If Responses mode is not confirmed, continue one Responses-mode round at a time:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint responses --responseStrategy implicit-derived-key --runs 6
```

After Responses mode is confirmed, lock the Responses strategy and continue one Chat round at a time:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint chat --chatStrategy chat-session-header-prompt-cache-key --confirmedResponseStrategy prompt-key-session-header --runs 6
```

Use `cache-matrix` only for non-interactive exhaustion when the user explicitly approves running all remaining strategies without dashboard pauses. Scope the matrix to one request family at a time:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-matrix --endpoint responses --runs 6
```

Only after the standard round sequence is exhausted should you include late non-standard cache-control probes:

```bash
node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-matrix --matrixMode full --runs 6
```

## Cache Probe Sequence

Use this interactive order. Direct upstream `/v1/responses` is tested before any Chat Completions cache probing when the target is provider pre-detection.

1. Run the direct upstream Responses API check with the first parameter combination:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase upstream-responses --strategy prompt-key-session-header --runs 6
   ```
   Summarize whether `/responses` accepted the request, whether a `response.id` was returned, which parameters were accepted/rejected, and any cache-read usage fields. Each strategy runs 6 rounds: round 1 creates a response, round 2 tests `previous_response_id` chaining, and rounds 3-6 test cache stability. If the API rejects the combination or returns invalid output, move to the next direct `/responses` combination. Do not proceed to other modes until direct `/responses` is either accepted or exhausted.
2. If `prompt-key-session-header` fails, try the next direct `/responses` combination (`plain`, then `prompt-key-store-true`). After each attempt, summarize and stop only when the API returns valid output.
3. Once a direct `/responses` combination returns valid output, stop iterating and ask the user to verify the listed request IDs in provider/vendor dashboard logs. Do not call cache confirmed from probe output alone.
4. If the user confirms direct upstream Responses cache hits and all later rounds hit, lock that strategy as `confirmed-stable`. If the user confirms only some later rounds hit, mark it `confirmed-intermittent` and rerun the same strategy with a fresh key before calling it stable. Do not start Chat-boundary or Chat Completions probing until this decision is made (unless the user explicitly skips direct Responses).
5. If every direct `/responses` combination fails to return valid output, record `direct-upstream-responses` as `exhausted` and stop Responses-family probing for this provider.
6. Run the first Chat-boundary Responses-mode cache round only after direct upstream `/responses` is confirmed, exhausted, or the user explicitly says to skip it:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint responses --responseStrategy prompt-key-session-header --runs 6
   ```
   Summarize only `cacheSummary.responses` and ask the user to verify those request IDs in provider logs. Stop here until the user responds.
7. If the user confirms Chat-boundary Responses hits and all later rounds hit, lock `prompt-key-session-header` as `confirmed-stable`. If the user confirms only some later rounds hit, mark it `confirmed-intermittent` and rerun the same strategy with a fresh key before calling it stable. Do not start Chat until this decision is made.
8. If the user cannot find Chat-boundary Responses cache hits in provider logs, retry that boundary with the next strategy:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase responses-chain --strategy prompt-key-session-header
   ```
9. If Chat-boundary Responses mode still shows no dashboard-confirmed hit, try backend-derived prompt cache keys:
   ```bash
   node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase responses-chain --strategy implicit-derived-key
   ```
10. If Chat-boundary Responses mode needs prompt-key comparison, try:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase responses-chain --strategy prompt-key-store-true
    ```
11. If the provider rejects `store:true` or cache should be independent from response state, try:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase responses-chain --strategy prompt-key-store-false
    ```
12. If Chat-boundary Responses mode still has no confirmed strategy, continue the Responses strategy order one round at a time:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint responses --responseStrategy session-header-only --runs 6
    ```
13. Only after direct upstream Responses and Chat-boundary Responses are confirmed, exhausted, or intentionally skipped, test Chat Completions with the first Chat strategy:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase cache-round --endpoint chat --chatStrategy chat-session-header-prompt-cache-key --confirmedResponseStrategy prompt-key-session-header --runs 6
    ```
    Stop and ask the user to verify Chat request IDs in provider logs.
14. If the user cannot find Chat cache hits, continue Chat route strategies one at a time:
    ```bash
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase chat-cache --strategy chat-session-header --runs 6
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase chat-cache --strategy chat-prompt-cache-key --runs 6
    node .cursor/skills/cursorproxy-provider-probe/scripts/probe-openai-compatible.mjs --phase chat-cache --strategy chat-repeat --runs 6
    ```
    Run only one of these commands per round, then pause for dashboard confirmation.
15. Only when the standard matrix is exhausted, or when a backend appears to be Anthropic-compatible behind an OpenAI facade, try cache-control content blocks. Keep the one-family-at-a-time rule.
16. Pause after each cache round and ask the user to verify provider logs. Then report which strategy appears compatible with cursorProxy as-is and which would require runtime changes.

## Interpretation Rules

- Provider pre-detection is about the upstream contract: native model IDs, accepted parameters, cache hints, response IDs, and usage fields. Do not use cursorProxy aliases or route assumptions to judge the provider.
- During direct provider pre-detection, `cache-round --endpoint responses` is not a direct Responses API test because it sends `/chat/completions`. Use `--phase upstream-responses` for direct upstream `/v1/responses`.
- cursorProxy Responses mode is public-boundary compatible only when requests to `/openaicompat/v1/chat/completions` return OpenAI Chat Completions JSON/SSE while the upstream route is `/v1/responses`.
- Direct `/responses` calls to cursorProxy are not the main runtime path for `OPENAICOMPAT_WIRE_API=responses`; use them only as upstream-shape diagnostics.
- A direct upstream `/openaicompat/v1` path may be an HTML app shell or nonexistent. Treat HTTP 200 with `text/html` as an API-shape failure, not a working endpoint.
- `compatible-*` model IDs are cursorProxy aliases. Direct upstream probes must use provider-native IDs from `/models`, for example `gpt-5.5` on providers that advertise that model.
- `previous_response_id` is state chaining. It is separate from prompt-cache billing and should be verified with cursorProxy logs such as `PREV_RESP_ID_FOUND`, `INPUT_CHAIN`, `STREAM_OAI_RESP_ID`, and `CACHE_OAI_RESP_ID`.
- `prompt_cache_key` is a routing hint. Treat `usage.prompt_tokens_details.cached_tokens` as cache-read evidence, but confirm billing-sensitive conclusions with provider dashboards/logs.
- Chat cache `facade` and `remote` modes must stay on `/v1/chat/completions`; they must not inject `previous_response_id`, trim messages, or write `oairesp:` response state.
- In Chat `remote` mode, cursorProxy may inject a `remote_*` `prompt_cache_key`; in Chat `facade` mode it only normalizes cache-hit usage and may force `stream_options.include_usage=true` for streaming.
- Current cursorProxy Chat `remote` mode derives `prompt_cache_key` from `Session_id`, `conversation_id`, or content, but it does not necessarily forward the original `Session_id` header upstream. If provider pre-detection confirms that both `prompt_cache_key` and `Session_id` are required, record that as a cursorProxy code gap.
- In Responses `sub2api` mode, cursorProxy may inject `compat_cc_*` `prompt_cache_key` for GPT-5/Codex-like models and scope `oairesp:` state with session anchors.
- Treat these usage fields as cache-read signals: `prompt_tokens_details.cached_tokens`, `input_tokens_details.cached_tokens`, `cached_tokens`, `prompt_cache_hit_tokens`, `choices[].usage.cached_tokens`, `cache_read_input_tokens`, camelCase equivalents, `usageMetadata.cachedContentTokenCount`, and `timings.cache_n`.
- Treat `cache_creation_input_tokens`, `cached_creation_tokens`, and `input_tokens_details.cached_creation_tokens` as cache-write signals, not proof that the next request hit the cache.
- Responses mode and Chat Completions mode can have different cache behavior. A confirmed Responses-mode hit does not prove Chat Completions hits, and a chat miss does not disprove Responses-mode cache support.
- If one mode is confirmed and the other is not, preserve the confirmed mode's strategy and continue testing only the unconfirmed mode.
- Treat cache stability separately from cache mechanism detection. A `1/2` post-warm-up hit rate means the mechanism is confirmed but intermittent; do not summarize that as fully complete or stable.
- If multiple strategies are run sequentially without a user confirmation pause, later strategies may be warmed by earlier rounds. Treat those results as non-isolated and rerun the candidate strategy in a fresh bounded round before calling it confirmed.
- If cache-read tokens appear only because all input tokens were moved into `cache_read_input_tokens`, warn that this can be a proxy-side billing rewrite. Confirm with provider dashboard/logs.
- If `cache_control` content blocks work in an OpenAI-compatible route, identify that as Anthropic-style behavior. cursorProxy's generic OpenAI-compatible path should treat this as non-standard provider-specific evidence.

## Required Final Report

After the baseline, parameter, and cache probes, report these sections:

1. API ability:
   - Provider `/v1/chat/completions`: works or not, native model ID used, accepted/rejected notable parameters, usage shape, and whether cache usage fields appeared.
   - Direct upstream `/v1/responses`, if tested: works or not, which parameter combination first returned valid output, streaming behavior, accepted/rejected notable parameters, usage shape, response ID visibility, and whether cache usage fields appeared.
   - cursorProxy Responses mode through public Chat: works or not, response-ID visibility, mapped response shape, cache usage fields, and relevant cursorProxy log tags.
2. Cache-hit mechanism:
   - For direct upstream Responses API, name the first parameter combination that returned valid output and whether the user confirmed cache hits for it.
   - For Chat-boundary Responses-mode probing, name the successful strategy such as default response-ID chaining, `prompt_cache_key + Session_id`, derived key, `store:false`, or `codex-client-metadata`.
   - For Chat Completions mode, name the successful strategy such as stable prefix only, `Session_id`, `prompt_cache_key`, `prompt_cache_key + Session_id`, or say cache is unconfirmed.
   - Include max observed cache-read tokens, hit rate after the first warm-up request, stability status, and the request IDs the user should verify in provider logs.
3. cursorProxy compatibility:
   - Say what works as-is and whether the provider was probed directly or through cursorProxy.
   - Say what requires env/runtime changes, such as `OPENAICOMPAT_WIRE_API=responses`, `OPENAICOMPAT_CACHE_HIT_MODE=sub2api`, `OPENAICOMPAT_CHAT_CACHE_MODE=facade|remote`, explicit `/openaicompat/v1` routing, or avoiding `store:false` when response-ID chaining is needed.
   - Say what requires code changes, especially if the provider needs an upstream `Session_id` header in addition to `prompt_cache_key`, if native model IDs cannot be represented by current cursorProxy aliases, or if HTML/non-JSON route fallback must be avoided.
   - Recommend exact cursorProxy cache settings when the strategy is expressible by current env vars:
     - Default Responses chaining: `OPENAICOMPAT_WIRE_API=responses`, no cache-hit mode required.
     - sub2api-like Responses prompt-cache routing: `OPENAICOMPAT_WIRE_API=responses` and `OPENAICOMPAT_CACHE_HIT_MODE=sub2api`.
     - Chat upstream-owned cache/session routing: `OPENAICOMPAT_WIRE_API=chat` and `OPENAICOMPAT_CHAT_CACHE_MODE=remote`.
     - Chat usage/accounting normalization only: `OPENAICOMPAT_WIRE_API=chat` and `OPENAICOMPAT_CHAT_CACHE_MODE=facade`.
     - Custom or conflicting per-mode needs: state the exact mode split and note that cursorProxy's env vars are deployment-wide, not a per-provider UI matrix.
4. Safety:
   - Do not print API keys.
   - Remind the user to rotate any key pasted into chat.

## Output

The probe emits JSON. Use these fields first:

- `diagnosis.keyWorks`
- `diagnosis.chatCompletionsWorks`
- `diagnosis.responsesChainWorks`
- `diagnosis.discrepancies`
- `runtimeExpectation`
- `providerReport`
- `cacheSummary`
- for `--phase cache-round`, `cacheSummary.round`, `cacheSummary.round.userConfirmationRequired`, `cacheSummary.round.responses.testedStrategy`, and `cacheSummary.round.chatCompletions.testedStrategy`
- for `--phase cache-matrix`, `cacheSummary.matrix`, `cacheSummary.matrix.responses`, `cacheSummary.matrix.chatCompletions`, `confirmedStrategy`, `testedStrategies`, `hitStrategies`, and `exhausted`
- each result's `status`, `contentType`, `object`, `responseId`, `usage`, `cacheSignals`, `diagnosticHeaders`, `errorDetail`, and `textSample`
- cache stability fields: `hitRate`, `stability`, `stableAfterWarmup`, `intermittentHit`, `laterHitCount`, and `laterRoundCount`

Do not paste long raw SSE payloads into final answers. Summarize status, rejected fields, response IDs, cached-token counts, request IDs, and the relevant cursorProxy diagnostic tags to check.
