# Kimi K3 Support

## Purpose

Validate native Moonshot `kimi-k3` routing, K3-specific request sanitization,
preserved reasoning across turns, forced tool choice, and native image input.

## Provider And Model

- Cursor model: `cursorproxy/kimi-k3` (or bare `kimi-k3`)
- Provider route: `kimi`
- Cursor mode: Agent

## Preconditions

- `KIMI_API_KEY` set to a Moonshot API key
- `CURSORPROXY_API_KEY` set
- KV configured (`REDIS_URL`, `KV_URL` + `KV_TOKEN`, or EdgeOne KV binding)
- `CURSORPROXY_MODELS` includes `kimi-k3` (or is unset)
- Deployed proxy includes Kimi K3 support

## Test Steps

### Test 1: Basic K3 completion

Start a new chat and paste:

```text
Explain why binary search is logarithmic in four concise sentences.
```

Expected Cursor behavior:

- Returns a coherent four-sentence answer.
- No upstream 400 mentioning sampling parameters, `thinking`, or
  `reasoning_effort`.

Expected logs (group by `requestId`):

```text
REQ POST /v1/chat/completions provider: kimi
KIMI_BODY_SANITIZED model: kimi-k3 thinkingType: (omitted) reasoningEffort: max ... maxCompletionTokens: ...
RES 200 provider: kimi ms: ...
```

The sanitized request must omit `temperature`, `top_p`, `n`,
`presence_penalty`, `frequency_penalty`, and `thinking`. It must send
`reasoning_effort: "max"`.

### Test 2: Multi-turn preserved reasoning

In the same chat, paste:

```text
Now give a concrete eight-element example and show each search interval.
```

Expected Cursor behavior:

- Continues from the first answer without a missing-reasoning error.
- Produces a valid interval sequence.

Expected logs on turn 2:

```text
INJECT_SUMMARY turns: 1 hits: 1 misses: 0 recovered: 0
```

`hits: >= 1` proves that complete K3 reasoning was restored into the prior
assistant message from the model-qualified K3 cache scope.

### Test 3: Forced tool loop

Start a new Agent chat and paste:

```text
Use the file search tool to locate package.json, then report only its package name and version.
```

Expected Cursor behavior:

- Invokes the requested file tool and returns the requested fields.
- Completes any tool-result follow-up without a missing `reasoning_content`
  error.
- A forced or named function `tool_choice` is preserved rather than rewritten
  to `auto`.

Expected logs:

```text
KIMI_BODY_SANITIZED model: kimi-k3 ... toolChoice: required ...
```

For a named function choice, `toolChoice: function:function` is expected.
`KIMI_TOOL_CHOICE_FIXED` must not appear for K3.

### Test 4: Native image input

Start a new chat, attach a small PNG or JPEG directly in Cursor, and paste:

```text
Describe the main visible object and list two colors present in the image.
```

Expected Cursor behavior:

- Describes the attached image accurately.
- The request succeeds through native K3 multimodal input.

Expected logs:

```text
KIMI_BODY_SANITIZED model: kimi-k3 ...
RES 200 provider: kimi ms: ...
```

`CONVERTED_IMAGES` and `VISION_CONVERTED` must not appear. The upstream media
reference must be base64 data or an `ms://` URI; ordinary remote HTTP image
URLs are outside the supported K3 media contract.

## Negative Signs

- Upstream 400 mentioning a fixed sampling field
- Upstream 400 saying `thinking` is unsupported
- Outbound `reasoning_effort` is absent or not `max`
- `max_completion_tokens` is converted to `max_tokens` or raised to 16,000
- `required` or named function tool choice is rewritten to `auto`
- Turn 2 reports `INJECT_SUMMARY ... hits: 0` with healthy KV
- K2 reasoning is restored into a K3 conversation
- `reasoning_content` leaks into the client-visible JSON or SSE response
- `CONVERTED_IMAGES` appears for native K3 media

## Cleanup

No project files should be created by these tests.
