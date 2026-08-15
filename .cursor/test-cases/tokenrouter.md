# TokenRouter — Kimi K3 and DeepSeek V4

## Purpose

Validate PaleBlueDot TokenRouter routing for the three initial catalog IDs,
K3 request sanitization, DeepSeek vision bridging, multi-turn reasoning
restore, streaming, and native Kimi/DeepSeek isolation.

## Provider And Model

- Cursor models:
  - `cursorproxy/moonshotai/kimi-k3`
  - `cursorproxy/deepseek/deepseek-v4-pro-0813`
  - `cursorproxy/deepseek/deepseek-v4-flash-0731`
- Provider route: `tokenrouter`
- Deployment: Docker / 1Panel (primary) or Vercel/EdgeOne
- Cursor mode: Agent

## Preconditions

- `TOKENROUTER_API_KEY` set to a PaleBlueDot TokenRouter key
- `CURSORPROXY_API_KEY` set
- KV configured (`REDIS_URL`, `KV_URL` + `KV_TOKEN`, or EdgeOne KV binding)
- `CURSORPROXY_MODELS` includes the three TokenRouter IDs (or enter them manually)
- Vision backend configured (`MINIMAX_API_KEY` or OpenAI vision) for the DeepSeek image test
- `DEBUG=true` while collecting `TOOL_CALL_NAME` troubleshooting evidence

## Test Steps

### Test 1: TokenRouter K3 basic completion

Start a new chat with `cursorproxy/moonshotai/kimi-k3` and paste:

```text
Explain why binary search is logarithmic in four concise sentences.
```

Expected Cursor behavior:

- Returns a coherent four-sentence answer.
- No upstream 400 mentioning sampling parameters, `thinking`, or `developer`.

Expected logs (group by `requestId`):

```text
REQ POST /v1/chat/completions provider: tokenrouter
KIMI_BODY_SANITIZED model: moonshotai/kimi-k3 thinkingType: (omitted) reasoningEffort: max ...
RES 200 provider: tokenrouter ms: ...
```

The outbound model must be `moonshotai/kimi-k3`. `UPSTREAM` must point at
`api.tokenrouter.com`, not `api.moonshot.ai`.

### Test 2: TokenRouter K3 multi-turn reasoning

In the same chat, paste:

```text
Now give a concrete eight-element example and show each search interval.
```

Expected Cursor behavior:

- Continues from the first answer without a missing-reasoning error.

Expected logs on turn 2:

```text
INJECT_SUMMARY turns: 1 hits: 1 misses: 0 recovered: 0
```

`hits: >= 1` proves complete K3 reasoning was restored from the
model-qualified TokenRouter cache scope.

### Test 3: TokenRouter K3 tool loop and native image

Start a new Agent chat with `cursorproxy/moonshotai/kimi-k3`. Attach a small
PNG or JPEG and paste:

```text
Use the file search tool to locate package.json, then report only its package name and version. Also name the main visible object in the attached image.
```

Expected Cursor behavior:

- Invokes a file tool and describes the image.
- Completes tool-result follow-up without a missing `reasoning_content` error.

Expected logs:

```text
KIMI_BODY_SANITIZED model: moonshotai/kimi-k3 ...
TOOL_CALL_NAME provider: tokenrouter model: moonshotai/kimi-k3 stream: true ...
```

`CONVERTED_IMAGES` must not appear for this K3 image. `KIMI_TOOL_CHOICE_FIXED`
must not appear.

### Test 4: TokenRouter DeepSeek Flash tools and vision bridge

Start a new Agent chat with `cursorproxy/deepseek/deepseek-v4-flash-0731`.
Attach a small PNG and paste:

```text
Describe the attached screenshot in one sentence, then list the files in this directory.
```

Expected Cursor behavior:

- Describes the image from the vision-bridge text, then uses a listing tool.
- Follow-up tool turns do not fail with missing `reasoning_content`.

Expected logs:

```text
REQ POST /v1/chat/completions provider: tokenrouter
CONVERTED_IMAGES ok: 1 err: 0 provider: tokenrouter ...
RES 200 provider: tokenrouter ms: ...
```

On a later user turn that still carries tools:

```text
INJECT_SUMMARY turns: ... hits: >= 1 ...
```

The outbound model must remain `deepseek/deepseek-v4-flash-0731`. Native
DeepSeek `thinking: { type: "enabled" }` injection is not required for this
gateway path.

### Test 5: TokenRouter DeepSeek Pro streaming

Start a new chat with `cursorproxy/deepseek/deepseek-v4-pro-0813` and paste:

```text
Write a Python function that returns the nth Fibonacci number. Keep it under 10 lines.
```

Expected Cursor behavior:

- Streams a short Python function.
- The client-visible model stays `cursorproxy/deepseek/deepseek-v4-pro-0813`.

Expected logs:

```text
REQ POST /v1/chat/completions provider: tokenrouter
STREAM_DONE ...
RES 200 provider: tokenrouter ms: ...
```

### Test 6: No regression — native Kimi and DeepSeek

In a new chat, switch to `cursorproxy/kimi-k3` (no `moonshotai/` prefix) and
paste:

```text
Write a Python function that calculates factorial. Keep it under 8 lines.
```

Expected logs:

```text
REQ POST /v1/chat/completions provider: kimi
UPSTREAM https://api.moonshot.ai/v1/chat/completions provider: kimi
```

Then switch to `cursorproxy/deepseek-v4-flash` and paste the same prompt.

Expected logs:

```text
REQ POST /v1/chat/completions provider: deepseek
UPSTREAM https://api.deepseek.com/v1/chat/completions provider: deepseek
THINKING provider: deepseek ...
```

## Negative Signs

- `provider: kimi` or `provider: deepseek` when using a TokenRouter-qualified ID
- `UPSTREAM` pointing at Moonshot or DeepSeek for a TokenRouter model
- `moonshotai/kimi-k3` falling through to DeepSeek
- `KIMI_BODY_SANITIZED` missing on TokenRouter K3
- `CONVERTED_IMAGES` on TokenRouter K3 media, or missing on TokenRouter DeepSeek media
- Turn 2 TokenRouter K3 `INJECT_SUMMARY ... hits: 0` with healthy KV
- TokenRouter DeepSeek tool loop 400 about missing `reasoning_content`
- Client-visible `reasoning_content`
- Native `cursorproxy/kimi-k3` or `cursorproxy/deepseek-v4-flash` routing to TokenRouter

## Cleanup

No project files should be created by these tests.
