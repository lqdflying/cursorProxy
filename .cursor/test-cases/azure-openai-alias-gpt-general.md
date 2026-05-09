# Azure OpenAI alias `cursorproxy/gpt-general`

## Purpose

Verify that requests for the public alias `cursorproxy/gpt-general` are
rewritten in-flight to the real Azure deployment named in
`AZURE_OPENAI_GENERAL_ALIAS_TARGET`, that `AZURE_OPENAI_GENERAL_REASONING_EFFORT`
overrides the global `AZURE_OPENAI_REASONING_EFFORT` only for this alias, and
that the response `model` field stays as `cursorproxy/gpt-general` so Cursor
sees the alias it asked for (the resolved deployment name must not leak).

## Provider And Model

- Cursor model: `cursorproxy/gpt-general`
- Provider route: `azureopenai` (via `providerFromModel()` alias-map / `gpt-` prefix match)
- Deployment: whatever `AZURE_OPENAI_GENERAL_ALIAS_TARGET` points at (e.g. `gpt-5.5-mini`)
- Cursor mode: agent (streaming chat/completions)

## Preconditions

- Required env vars (Vercel project or Docker `.env`):
  - `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_RESOURCE` already set as usual.
  - `AZURE_OPENAI_GENERAL_ALIAS_TARGET=<real deployment, e.g. gpt-5.5-mini>`
  - `AZURE_OPENAI_GENERAL_REASONING_EFFORT=medium` (any value distinct from the global so the precedence is observable)
  - `AZURE_OPENAI_REASONING_EFFORT=high` (existing global; this should be overridden by the alias env above)
  - `CURSORPROXY_MODELS` contains `gpt-general` (or `cursorproxy/gpt-general`) so the alias appears in `/v1/models`.
- Required deployment state: latest production deploy includes the alias resolution code (`AZURE_ALIAS_RESOLVED` diag tag emitted by `api/proxy.js`).
- Required files or workspace state: none.

## Test Steps

1. Confirm `/v1/models` advertises the alias:

   ```bash
   curl -s -H "Authorization: Bearer $CURSORPROXY_API_KEY" \
     https://<your-host>/v1/models | jq '.data[] | select(.id|test("gpt-general"))'
   ```

   Expected: one entry with `"id": "cursorproxy/gpt-general"`.

2. Paste this prompt into Cursor (with `cursorproxy/gpt-general` as the active model):

   ```text
   Reply with a single short sentence describing what model name you are responding from.
   ```

3. Expected Cursor behavior:

   - The chat completes normally with a streamed reply.
   - In the response stream, every chunk's `model` field is `cursorproxy/gpt-general` (verify via Cursor devtools or by hitting the proxy directly with `curl`).

4. Expected file/content changes: none.

5. Negative-test: temporarily unset `AZURE_OPENAI_GENERAL_ALIAS_TARGET` and re-send the request. Expect HTTP 503 with body:

   ```json
   {"error":{"message":"Azure OpenAI alias \"gpt-general\" is registered but AZURE_OPENAI_GENERAL_ALIAS_TARGET is not set. Set AZURE_OPENAI_GENERAL_ALIAS_TARGET to the real Azure deployment name.","type":"api_error","code":"azure_alias_unconfigured"}}
   ```

## Expected Vercel logs

Search Vercel runtime logs for the request and confirm all of the following are present (use `.cursor/rules/vercel-log-investigation.mdc` for grouping by `requestId`):

```text
REQ POST /v1/chat/completions provider: infer
AZURE_ALIAS_RESOLVED alias: gpt-general target: <deployment>
REASONING_EFFORT effort: medium provider: azureopenai source: alias alias: gpt-general
PREV_RESP_ID_FOUND ...           # or PREV_RESP_ID_MISS on first turn
INPUT_CHAIN provider: azureopenai ...   # or MESSAGES_TO_INPUT for legacy clients
AZURE_STREAM_SUMMARY reason: response.completed ... events: {... "response.completed": 1 ...}
RES 200 provider: azureopenai ms: <ms>
```

The streaming chunks emitted to the client must show `"model":"cursorproxy/gpt-general"` (alias preserved by `withPublicResponseModel(json, responseModelName, forceAlias=true)`).

## Negative signs

```text
AZURE_ALIAS_RESOLVED                # missing → alias resolution did not run
REASONING_EFFORT ... source: global # alias-only env was ignored / not in use
REASONING_EFFORT ... source: client # no env override applied (both AZURE_OPENAI_*_REASONING_EFFORT unset or not allowed value)
```

If a streamed chunk shows `"model":"cursorproxy/<resolved deployment>"` (e.g. `cursorproxy/gpt-5.5-mini`) instead of `cursorproxy/gpt-general`, the `forceAlias` flag was not propagated to `withPublicResponseModel` — open a regression ticket.

If `AZURE_ALIAS_UNCONFIGURED alias: gpt-general targetEnv: AZURE_OPENAI_GENERAL_ALIAS_TARGET` appears alongside a 200 response, the early-return for unconfigured aliases was bypassed.

## Cleanup

None — the test does not create files or persistent state. Restore `AZURE_OPENAI_GENERAL_ALIAS_TARGET` if you removed it for the negative test.

## Notes

- Reasoning-effort precedence (highest first): alias env (`AZURE_OPENAI_GENERAL_REASONING_EFFORT`) > global env (`AZURE_OPENAI_REASONING_EFFORT`) > client value, all gated on `isAzureReasoningModel(<resolvedDeployment>)`.
- If `AZURE_OPENAI_GENERAL_ALIAS_TARGET` points at a non-reasoning deployment (e.g. `gpt-4o`), `AZURE_OPENAI_GENERAL_REASONING_EFFORT` is silently ignored — same gating as the existing global knob.
- `previous_response_id` chaining is keyed by user, not by model, so switching the alias target mid-conversation can produce `previous_response_not_found` (existing behavior; not unique to aliasing).
- Implementation entrypoints: `resolveAzureAlias()` in `api/models.js`, alias block in `api/proxy.js` after the initial `normalizeParsedBodyModel(...)`, `aliasInfo` plumbed into `sanitizeAzureOpenAIBody()` in `api/azure-openai.js`, `forceAlias` arg in `withPublicResponseModel()` in `api/models.js`.

## apply_patch Caveat

Do not use this alias test as proof that Cursor exposes its `apply_patch`
editing tool for `cursorproxy/gpt-general`. Cursor appears to choose its local
tool surface from the client-facing model id before the proxy can rewrite the
alias. In the observed failure on 2026-05-09, production logs showed:

```text
AZURE_ALIAS_RESOLVED alias: gpt-general target: gpt-5.5
TOOLS_SHAPE ... chatCmplFmt: 20 ... knownType: 0
AZURE_STREAM_SUMMARY ... functionArgDeltas: 0 ... response.output_text.delta ...
```

The model then replied that no `apply_patch` editing tool was exposed. That is
not the historical proxy bug where `response.custom_tool_call_input.delta` was
dropped; it means Cursor did not send the custom/native `apply_patch` tool for
the `gpt-general` model id. For apply-patch verification, use
`.cursor/test-cases/azure-openai-responses-apply-patch.md` with a Cursor-facing
model id that Cursor recognizes as apply-patch capable, such as the real Azure
OpenAI proxy model id used for coding (`cursorproxy/gpt-5.4` in the current
test notes) rather than this generic alias.
