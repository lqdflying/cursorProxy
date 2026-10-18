# October 2026 model refresh

## Preconditions and routes

Use an already deployed proxy with the relevant provider keys, KV and temporary `DEBUG=true`. Main production traffic runs through 1Panel/Docker; use its logs or Axiom. Vercel/EdgeOne installations use the same event fields. Group each request's REQ, provider diagnostics, RES and terminal records together; do not confuse concurrent model runs.

Select each supported model through `https://<host>/v1`:

| Provider | Cursor model IDs to exercise |
|---|---|
| DeepSeek | `cursorproxy/deepseek-flash`, `cursorproxy/deepseek-v4-pro` |
| MiMo | `cursorproxy/mimo-v2.6-pro`, `cursorproxy/mimo-v2.6-flash`, `cursorproxy/mimo-v2.6-pro-ultraspeed` |
| GLM | `cursorproxy/glm-5.3`, `cursorproxy/glm-5.3-flash`, `cursorproxy/glm-5.3-flashx` |
| Kimi | `cursorproxy/kimi-k3`, `cursorproxy/kimi-k2.7-code-highspeed` |
| MiniMax | `cursorproxy/MiniMax-M3`, `cursorproxy/MiniMax-M3.1-Flash-Preview` (requires preview access) |
| Fireworks | `cursorproxy/fireworks/deepseek-v4p1-flash`, `cursorproxy/fireworks/kimi-k3`, `cursorproxy/fireworks/glm-5p3`, `cursorproxy/fireworks/glm-5p3-flash`, `cursorproxy/fireworks/minimax-m3` |
| OpenAI-compatible | `cursorproxy/compatible-gpt-6.1-sol`, `cursorproxy/compatible-gpt-6-astra`, `cursorproxy/compatible-gpt-6-luna` |
| Claude compatible | `cursorproxy/compatible-claude-sonnet-5-5`, `cursorproxy/compatible-claude-opus-5-5`, `cursorproxy/compatible-claude-haiku-5-5`, `cursorproxy/compatible-claude-fable-5-1` |
| Azure | Bare GPT-6/Claude names above or configured `gpt-general`; deployment/access must exist. |

Use `OPENAICOMPAT_WIRE_API=responses` for GPT-6 coding/tools. Keep generic gateway mode as verified for that endpoint. Claude-compatible reuse needs `ANTHROPICCOMPAT_THINKING_CACHE=true`. GLM FlashX requires `UPSTREAM_GLM=https://api.z.ai/api/paas/v4`, separate from a Coding Plan deployment. Do not alter live configuration merely to run this document without operational authorization.

## Conversation and tool loop

For each selected model, start a fresh chat and paste:

```text
Read .cursor/test-cases/TEMPLATE.md. List its top-level headings in order. Do not edit files.
```

Then paste:

```text
Read the same file again and report whether the heading order changed. Do not edit files.
```

Expected: tools complete, answers reflect file content, no file changes, no exposed reasoning or signatures, no blank assistant turn or stalled tool call. New alias response IDs remain the selected public model. Native DeepSeek tool turns restore reasoning across the new user turn. MiniMax's string or legacy structured reasoning stays invisible and survives the follow-up.

Expected log fields (numeric placeholders vary):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: infer
[cursorProxy:proxy] COMPATIBLE_ALIAS_RESOLVED alias: compatible-gpt-6.1-sol upstream: gpt-6.1-sol
[cursorProxy:proxy] FIREWORKS_MODEL_RESOLVED bare: fireworks/kimi-k3 upstream: accounts/fireworks/models/kimi-k3
[cursorProxy:proxy] RES 200 provider: <resolved provider> ms: <number>
[cursorProxy:proxy] INJECT_SUMMARY turns: <number> hits: <number> misses: <number> recovered: <number>
[cursorProxy:proxy] CLAUDE_THINKING_CACHED key: <hash> blocks: <number> chars: <number>
[cursorProxy:proxy] CLAUDE_THINKING_INJECTED count: <number>
```

Only expect the provider-relevant events. Claude `chars: 0` with a cached signature is valid. GPT Responses additionally requires `OAI_STREAM_LIFECYCLE wire: responses status: 200 ... terminal: completed ... doneSeen: true ... timedOut: false cancelled: false stage: (none)`; RES 200 alone does not prove completion. On a changed Claude model/system/tools/account/endpoint, old thinking must not be injected; unchanged context should still hit.

## Image matrix

Attach a simple screenshot of a red square and paste:

```text
Name the color and shape in this image. Answer in five words or fewer.
```

Flash DeepSeek, MiMo V2.6 Pro/Flash/Pro Ultraspeed, GLM 5.3 Flash/FlashX, MiniMax M3/M3.1, GPT and Claude should use native images. Text-only DeepSeek V4 Pro, legacy MiMo V2.5 Pro, GLM-5.3 and Fireworks GLM-5p3 should emit `CONVERTED_IMAGES ok: 1 err: 0 provider: <provider> visionMs: <number>`. Native images should not emit that event. Any false image description, bridge on a native model, or unsupported image error is a failure.

## API-only checks and deterministic replay

Cursor UI cannot reliably omit model IDs, select precise effort/thinking fields, fabricate signature-only responses, or expose cache-write usage. Use the shared-handler replay:

```bash
/usr/bin/node test/model-refresh.test.js
```

It verifies these cases without a localhost server or paid requests:

- Defaults and public/bare/alias/provider route shapes; explicit retired IDs remain discoverable.
- Native GLM 5.3/Flash standard API accepts low/high/max; Coding Plan also forwards none/minimal/medium/xhigh for upstream mapping, with thinking still enabled. Both Z.AI and ZHIPU endpoints reject invalid effort and disabled thinking with `400 glm_parameter_invalid` before any upstream call. Default max and env > client precedence (including quoted/trimmed env values) hold; gateway/5.2 behavior stays unchanged; FlashX rejects Coding Plan and uses the strict enum on the standard API.
- MiMo V2.6 Pro preserves exact image parts and makes one chat call for omitted/default, bare, explicit-provider and public model routes, even without vision-backend credentials. Legacy V2.5 Pro still makes a vision call followed by a chat call containing the caption on an image-cache miss.
- M3.1 disabled thinking/none effort/unsplit reasoning → `400 minimax_parameter_invalid`; M3 still accepts disabled thinking; JSON and SSE cache replay preserves the received reasoning field/type.
- New Claude manual budgets/unsupported thinking or forced choices → `400 claude_parameter_invalid`; Haiku forced tools retained, Sonnet between_tools at <=high succeeds, adaptive display is preserved.
- Native GPT-6 unsupported Chat tools → `400 gpt6_responses_required` with the Responses setting; effort normalization follows env precedence; cache-write tokens survive response mapping.
- Native images versus bridge routing, old cache readability, signature-only thinking and model/account/endpoint/system/tool isolation.

Negative signs: 400 on a valid combination, any upstream call for a locally rejected combination, leaked internal reasoning records/signatures, missing [DONE], stale thinking after a context switch, or changes to TokenRouter's catalog.

## Cleanup and limits

No test prompts create files. Restore temporary debug settings after approved live verification. Tests mock upstream transport and KV; they do not prove account availability, billing, regional access, real cache hits, production routing, or Cursor-side tool execution. Retain existing legacy regression cases for explicitly configured models.
