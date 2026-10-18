# MiMo Model-Aware Vision Routing

## Purpose

Confirm legacy text-only MiMo models (`mimo-v2.5-pro`) run images through the vision bridge (`CONVERTED_IMAGES`), while MiMo V2.6 Pro, Flash and Pro Ultraspeed forward `image_url` parts natively without vision-bridge conversion.

## Provider And Model

- Two runs required:
  1. `mimo-v2.5-pro` — vision bridge expected, subject to legacy model availability
  2. `mimo-v2.6-pro` — native passthrough expected (current default)
- Provider route: unified `https://<host>/v1`
- Deployment: `MIMO_API_KEY`; Part A also needs `MINIMAX_API_KEY` for the default vision provider; KV optional

## Preconditions

- Required env vars: `CURSORPROXY_API_KEY`, `MIMO_API_KEY`; `MINIMAX_API_KEY` for Part A only
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

1. Start a **new** chat or switch model to **`mimo-v2.6-pro`**.
2. Attach the same image.
3. Paste the same prompt as Part A.

Expected Cursor behavior:

- Answer still matches image content (model reads image natively).

Expected logs (always-on):

```text
[cursorProxy:proxy] REQ POST /v1/chat/completions provider: mimo
[cursorProxy:proxy] RES 200 provider: mimo
```

With `DEBUG=true`, also expect `RESOLVED model: mimo-v2.6-pro provider: mimo`.

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

- Repeat Part B with `mimo-v2.6-flash` and `mimo-v2.6-pro-ultraspeed`, which also use native vision. Explicit legacy routes keep their previous behavior, subject to upstream availability.
- Cursor cannot reliably omit the model or isolate vision credentials. `/usr/bin/node test/model-refresh.test.js` verifies default/bare/public Pro routes without vision-backend credentials and checks exact outbound image parts and fetch counts. No live configuration changes are needed for this replay.
- If Part A fails with empty/wrong answers but no `CONVERTED_IMAGES`, the gate in `requiresVisionBridge()` may be misconfigured.
