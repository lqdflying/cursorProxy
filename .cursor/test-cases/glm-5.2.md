# GLM-5.2 Coding Plan

## Purpose

Validate GLM provider routing, ZHIPU/Z.AI Coding Plan URL construction, GLM request sanitization, thinking/reasoning handling, tool streaming, and GLM-5.2 vision bridge behavior.

## Provider And Model

- Cursor model: `GLM-5.2` (or `cursorproxy/GLM-5.2` if using discovery prefix)
- Provider route: unified `https://<host>/v1` and legacy `https://<host>/glm/v1`
- Deployment: production, EdgeOne, or Docker with `GLM_API_KEY` set
- Cursor mode: agent/chat mode that sends streaming chat completions

## Preconditions

- Required env vars: `CURSORPROXY_API_KEY`, `GLM_API_KEY`
- Optional: `CURSORPROXY_MODELS` includes `GLM-5.2` for discovery
- Optional upstream override for global Z.AI endpoint: `UPSTREAM_GLM=https://api.z.ai/api/coding/paas/v4`
- KV backend configured for multi-turn preserved-thinking checks
- Vision backend configured if testing image attachments with `GLM-5.2`

## Test Steps

Paste this prompt into Cursor:

```text
Think step by step privately, then answer in one sentence: write a JavaScript function named add42 that returns its numeric argument plus 42.
```

Expected Cursor behavior:

- The model answers with a small JavaScript function or equivalent explanation.
- No raw `reasoning_content` is visible in Cursor.
- Follow-up turns continue normally with the same conversation.

Expected file/content changes, if any:

- None

Expected Vercel logs (same `requestId` group, always-on):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: infer
[cursorProxy:proxy] GLM_BODY_SANITIZED model: glm-5.2 thinkingType: enabled clearThinking: false ...
[cursorProxy:proxy] RES 200 provider: glm ms: <number>
```

With `DEBUG=true`, also expect:

```text
[cursorProxy:proxy] RESOLVED model: cursorproxy/GLM-5.2 provider: glm stream: true
[cursorProxy:proxy] UPSTREAM https://open.bigmodel.cn/api/coding/paas/v4/chat/completions provider: glm
[cursorProxy:proxy] UPSTREAM_STATUS 200 provider: glm stream: true
```

For the global endpoint override, expect the `UPSTREAM` line to begin with:

```text
https://api.z.ai/api/coding/paas/v4/chat/completions
```

For legacy path coverage, repeat against `/glm/v1/chat/completions` and expect:

```text
[cursorProxy:proxy] REQ POST /glm/v1/chat/completions provider: glm
[cursorProxy:proxy] RES 200 provider: glm ms: <number>
```

For tool streaming coverage, use an agent prompt that requires a local file read or edit. Expected logs should include:

```text
[cursorProxy:proxy] GLM_BODY_SANITIZED ... toolStream: true ...
```

For `tool_choice: "none"` coverage, replay a request with tools plus `tool_choice: "none"`. Expected upstream body should omit `tools`, `tool_choice`, and `tool_stream`; `tool_choice: "none"` must not become `auto`.

For GLM preserved-thinking miss coverage, replay a follow-up request with a prior assistant turn, no KV hit, and either omitted thinking or client-supplied `thinking: { "type": "enabled" }` without `clear_thinking`. Expected logs should include:

```text
[cursorProxy:proxy] INJECT_MISS missed: <number> of: <number>
[cursorProxy:proxy] GLM_THINKING_CLEARED misses: <number> reason: missing_prior_reasoning
```

The forwarded body should include `thinking.clear_thinking: true` for that turn.

For image coverage, paste a small screenshot while using `GLM-5.2`. Expected logs should include:

```text
[cursorProxy:proxy] CONVERTED_IMAGES ok: <number> err: 0 provider: glm visionMs: <number>
```

Negative signs:

```text
UNKNOWN_PROVIDER ... provider: glm
Missing environment variable GLM_API_KEY
UPSTREAM https://open.bigmodel.cn/api/coding/paas/v4/v1/chat/completions
UPSTREAM_ERROR_STATUS
UPSTREAM_STATUS 400
reasoning_content ... prior reasoning unavailable
tool_choice: auto ... when client sent tool_choice: none
```

## Cleanup

None

## Notes

- China Coding Plan endpoint: `https://open.bigmodel.cn/api/coding/paas/v4`
- Global Z.AI Coding Plan endpoint: `https://api.z.ai/api/coding/paas/v4`
- GLM preserved thinking requires exact prior `reasoning_content`; the proxy does not fabricate placeholder reasoning on GLM KV misses and clears preserved thinking for that request.
