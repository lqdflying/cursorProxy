# TokenRouter — Kimi K3, DeepSeek V4, Qwen3.8-Max, and GLM 5.2

## Purpose

Validate PaleBlueDot TokenRouter routing for the five exact catalog IDs,
K3 request sanitization, Qwen request sanitization, GLM 5.2 request
sanitization, DeepSeek/Qwen/GLM vision bridging, multi-turn reasoning restore,
streaming, and native Kimi/DeepSeek/GLM isolation.

## Provider And Model

- Cursor models:
  - `cursorproxy/moonshotai/kimi-k3`
  - `cursorproxy/deepseek/deepseek-v4-pro-0813`
  - `cursorproxy/deepseek/deepseek-v4-flash-0731`
  - `cursorproxy/qwen/qwen3.8-max`
  - `cursorproxy/z-ai/glm-5.2`
- Provider route: `tokenrouter`
- Deployment: Docker / 1Panel (primary) or Vercel/EdgeOne
- Cursor mode: Agent

## Preconditions

- `TOKENROUTER_API_KEY` set to a PaleBlueDot TokenRouter key
- `CURSORPROXY_API_KEY` set
- KV configured (`REDIS_URL`, `KV_URL` + `KV_TOKEN`, or EdgeOne KV binding)
- `CURSORPROXY_MODELS` includes the five TokenRouter IDs (or enter them manually)
- Vision backend configured (`MINIMAX_API_KEY` or OpenAI vision) for the DeepSeek/GLM image test
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

Expected logs (pair each `REQ` with the following `RES` on the same Docker
process stream; `provider:` must stay `tokenrouter`):

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: tokenrouter
[cursorProxy:proxy] KIMI_BODY_SANITIZED model: moonshotai/kimi-k3 thinkingType: (omitted) reasoningEffort: max ...
[cursorProxy:proxy] RES 200 provider: tokenrouter ms: ...
```

On Docker/1Panel the public URL is still `/v1/chat/completions`; `server.js`
rewrites it before `api/proxy.js` logs `REQ`. When `DEBUG=true`, the optional
access line is `[cursorProxy:server] POST /v1/chat/completions -> 200 (...)`.

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
[cursorProxy:proxy] REQ POST /api/proxy provider: tokenrouter
[cursorProxy:proxy] CONVERTED_IMAGES ok: 1 err: 0 provider: tokenrouter ...
[cursorProxy:proxy] RES 200 provider: tokenrouter ms: ...
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
[cursorProxy:proxy] REQ POST /api/proxy provider: tokenrouter
[cursorProxy:proxy] STREAM_DONE ...
[cursorProxy:proxy] RES 200 provider: tokenrouter ms: ...
```

### Test 6: TokenRouter Qwen3.8-Max basic completion

Start a new chat with `cursorproxy/qwen/qwen3.8-max` and paste:

```text
Explain why binary search is logarithmic in four concise sentences.
```

Expected Cursor behavior:

- Returns a coherent four-sentence answer.
- No upstream 400 mentioning `thinking`, `developer`, or `reasoning_effort: max`.

Expected logs:

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: tokenrouter
[cursorProxy:proxy] TOKENROUTER_QWEN_SANITIZED model: qwen/qwen3.8-max thinkingType: ... reasoningEffort: ...
[cursorProxy:proxy] RES 200 provider: tokenrouter ms: ...
```

`TOKENROUTER_QWEN_SANITIZED` is present when the request carried `thinking` or `reasoning_effort` (Cursor Agent requests do). `thinkingType` is the pre-strip Cursor value (`enabled`, `disabled`, or `(omitted)` if `thinking` was absent). A curl body with neither field will not emit this line.

The outbound model must be `qwen/qwen3.8-max`. `UPSTREAM` must point at
`api.tokenrouter.com`. `enable_thinking` and `preserve_thinking` must not
appear in outbound diagnostics as injected fields. `KIMI_BODY_SANITIZED`
must not appear.

### Test 7: TokenRouter Qwen3.8-Max multi-turn reasoning

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

`hits: >= 1` proves Qwen reasoning was restored from the model-qualified
TokenRouter cache scope `tokenrouter:qwen/qwen3.8-max:<user>`.

### Test 8: TokenRouter Qwen3.8-Max tool loop and native image

Start a new Agent chat with `cursorproxy/qwen/qwen3.8-max`. Attach a small
PNG or JPEG and paste:

```text
Use the file search tool to locate package.json, then report only its package name and version. Also name the main visible object in the attached image.
```

Expected Cursor behavior:

- Invokes a file tool and describes the image.
- Completes tool-result follow-up without a missing `reasoning_content` error.

Expected logs:

```text
TOKENROUTER_QWEN_SANITIZED model: qwen/qwen3.8-max ...
TOOL_CALL_NAME provider: tokenrouter model: qwen/qwen3.8-max stream: true ...
```

`CONVERTED_IMAGES` must not appear for this Qwen image.

### Test 9: TokenRouter GLM 5.2 basic completion and image bridge

Start a new chat with `cursorproxy/z-ai/glm-5.2` and paste:

```text
Explain why binary search is logarithmic in four concise sentences.
```

Expected Cursor behavior:

- Returns a coherent four-sentence answer.
- No upstream 400 mentioning `thinking`, `developer`, `tool_stream`, or `max_tokens`.

Expected logs:

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: tokenrouter
[cursorProxy:proxy] TOKENROUTER_GLM_SANITIZED model: z-ai/glm-5.2 thinkingType: ... reasoningEffort: ... effortAction: kept|dropped|unset
[cursorProxy:proxy] RES 200 provider: tokenrouter ms: ...
```

The outbound model must be `z-ai/glm-5.2`. `UPSTREAM` must point at
`api.tokenrouter.com`. `GLM_BODY_SANITIZED`, `tool_stream`, `max_tokens`,
`enable_thinking`, and `preserve_thinking` must not appear. Client
`reasoning_effort` (when valid) is forwarded unchanged; invalid values are
dropped.

Then attach a small screenshot and ask "Describe this image". Expect
`CONVERTED_IMAGES` (GLM 5.2 is text-only upstream; images are bridged to
text), unlike K3/Qwen native images.

### Test 10: TokenRouter GLM 5.2 multi-turn reasoning

In the same chat, paste:

```text
Now give a concrete eight-element example and show each search interval.
```

Expected logs on turn 2:

```text
INJECT_SUMMARY turns: 1 hits: 1 misses: 0 recovered: 0
```

Scope is `tokenrouter:z-ai/glm-5.2:<user>`, isolated from native `glm:<user>`.

### Test 11: TokenRouter GLM 5.2 disable flags

In a new chat with `cursorproxy/z-ai/glm-5.2`, after a warm turn, send a
follow-up with reasoning effort set to `none` (or `thinking.type: disabled`
in the raw Cursor request). Expected: turn 2 has no `INJECT_SUMMARY hits: 1`
and `reasoning_effort: none` is forwarded (GLM accepts `none`); for
`thinking.type: disabled`, `thinking` is stripped and restore is skipped.

### Test 12: No regression — native Kimi, DeepSeek, and GLM

In a new chat, switch to `cursorproxy/kimi-k3` (no `moonshotai/` prefix) and
paste:

```text
Write a Python function that calculates factorial. Keep it under 8 lines.
```

Expected logs:

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: kimi
[cursorProxy:proxy] UPSTREAM https://api.moonshot.ai/v1/chat/completions provider: kimi
```

Then switch to `cursorproxy/deepseek-v4-flash` and paste the same prompt.

Expected logs:

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: deepseek
[cursorProxy:proxy] UPSTREAM https://api.deepseek.com/v1/chat/completions provider: deepseek
[cursorProxy:proxy] THINKING provider: deepseek ...
```

Then switch to `cursorproxy/glm-5.2` (native GLM, no `z-ai/` prefix) and
paste the same prompt.

Expected logs:

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: glm
[cursorProxy:proxy] GLM_BODY_SANITIZED model: glm-5.2 ...
```

`TOKENROUTER_GLM_SANITIZED` must not appear for native `glm-5.2`.

## Negative Signs

- `provider: kimi`, `provider: deepseek`, or `provider: glm` when using a TokenRouter-qualified ID
- `UPSTREAM` pointing at Moonshot, DeepSeek, or bigmodel.cn for a TokenRouter model
- `moonshotai/kimi-k3` falling through to DeepSeek
- `z-ai/glm-5.2` falling through to native GLM
- `KIMI_BODY_SANITIZED` missing on TokenRouter K3
- `CONVERTED_IMAGES` on TokenRouter K3 or Qwen media, or missing on TokenRouter DeepSeek/GLM media
- Turn 2 TokenRouter K3, Qwen, or GLM `INJECT_SUMMARY ... hits: 0` with healthy KV
- TokenRouter DeepSeek tool loop 400 about missing `reasoning_content`
- Client-visible `reasoning_content`
- Native `cursorproxy/kimi-k3`, `cursorproxy/deepseek-v4-flash`, or `cursorproxy/glm-5.2` routing to TokenRouter
- `KIMI_BODY_SANITIZED` on TokenRouter Qwen or GLM
- `GLM_BODY_SANITIZED` on TokenRouter GLM 5.2 (native GLM sanitizer must not run there)
- Outbound TokenRouter Qwen `enable_thinking` or `preserve_thinking`
- Outbound TokenRouter GLM 5.2 `tool_stream`, `max_tokens`, or GLM-native `thinking` injection

## Cleanup

No project files should be created by these tests.
