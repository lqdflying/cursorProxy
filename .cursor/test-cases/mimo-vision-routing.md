# MiMo Model-Aware Vision Routing

## Purpose

Confirm text-only MiMo models (`mimo-v2.5-pro`) run images through the vision bridge (`CONVERTED_IMAGES`), while multimodal MiMo models (`mimo-v2.5`) forward `image_url` parts natively without vision-bridge conversion.

## Provider And Model

- Two runs required:
  1. `mimo-v2.5-pro` — vision bridge expected
  2. `mimo-v2.5` — native passthrough expected
- Provider route: unified `https://<host>/v1`
- Deployment: `MIMO_API_KEY`, `MINIMAX_API_KEY` (default vision provider), KV optional

## Preconditions

- Required env vars: `CURSORPROXY_API_KEY`, `MIMO_API_KEY`, `MINIMAX_API_KEY`
- Cursor session where you can attach a small screenshot or image to the chat
- Use a tiny image (screenshot of a single word or number) so vision latency stays low

## Test Steps

### Part A — text-only model (vision bridge)

1. Select model **`mimo-v2.5-pro`**.
2. Attach an image that clearly shows a number or short word (e.g. screenshot showing `42`).
3. Paste:

```text
What number or word appears in the attached image? Answer with only that token.
```

Expected Cursor behavior:

- Answer matches the image content (vision bridge described the image as text upstream).

Expected logs (always-on):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: mimo
[cursorProxy:proxy] CONVERTED_IMAGES ok: 1
[cursorProxy:proxy] RES 200 provider: mimo
```

With `DEBUG=true`, also expect `RESOLVED model: mimo-v2.5-pro provider: mimo`.

Negative signs for Part A:

```text
(no CONVERTED_IMAGES line when an image was attached)
VISION_ERROR
```

### Part B — multimodal model (native passthrough)

1. Start a **new** chat or switch model to **`mimo-v2.5`**.
2. Attach the same image.
3. Paste the same prompt as Part A.

Expected Cursor behavior:

- Answer still matches image content (model reads image natively).

Expected logs (always-on):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: mimo
[cursorProxy:proxy] RES 200 provider: mimo
```

With `DEBUG=true`, also expect `RESOLVED model: mimo-v2.5 provider: mimo`.

Negative signs for Part B:

```text
CONVERTED_IMAGES
VISION_BATCH
[cursorProxy:vision]
```

Part B must **not** log `CONVERTED_IMAGES` or vision-module tags when only native multimodal passthrough is used.

## Cleanup

None

## Notes

- `mimo-v2-omni` should behave like `mimo-v2.5` (native vision). `mimo-v2-flash` and `mimo-v2-pro` behave like `mimo-v2.5-pro` (vision bridge).
- If Part A fails with empty/wrong answers but no `CONVERTED_IMAGES`, the gate in `requiresVisionBridge()` may be misconfigured.
