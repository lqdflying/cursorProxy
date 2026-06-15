# MiniMax M3 Native Support

## Purpose

Validate that MiniMax M3 requests bypass the vision bridge (native multimodal), receive `thinking: { type: "adaptive" }` injection, and continue to use `reasoning_split: true` for reasoning_details caching.

## Provider And Model

- Cursor model: `cursorproxy/MiniMax-M3`
- Provider route: `minimax`
- Deployment: Vercel (production)
- Cursor mode: Agent

## Preconditions

- `MINIMAX_API_KEY` set
- `CURSORPROXY_API_KEY` set
- `CURSORPROXY_MODELS` includes `MiniMax-M3` (or is unset)

## Test Steps

### Test 1: Basic text chat (no image)

Paste this prompt into Cursor:

```text
What is 2 + 2? Answer in one sentence.
```

Expected Cursor behavior:

- Returns `4` in a single sentence.
- Response is fast (thinking mode is adaptive, may skip deep thinking for trivial queries).

Expected Vercel logs:

```text
REQ POST /v1/chat/completions provider: minimax
MODEL_STRIP from: cursorproxy/MiniMax-M3 to: MiniMax-M3
RES 200 provider: minimax ms: ...
```

Verify no `CONVERTED_IMAGES` appears (no images to convert).

### Test 2: Image understanding (native multimodal)

Paste this prompt into Cursor (attach any image):

```text
Describe this image briefly.
```

Expected Cursor behavior:

- Returns a description of the image content.
- The response should be accurate and contextual (not a hallucinated/placeholder description).

Expected Vercel logs:

```text
REQ POST /v1/chat/completions provider: minimax
MODEL_STRIP from: cursorproxy/MiniMax-M3 to: MiniMax-M3
RES 200 provider: minimax ms: ...
```

Verify NO `CONVERTED_IMAGES` appears — M3 handles images natively, the vision bridge is bypassed.

Negative signs:

```text
CONVERTED_IMAGES
```

### Test 3: Reasoning cache (multi-turn)

Paste this prompt into Cursor:

```text
Explain the differences between REST and GraphQL in one paragraph.
```

Then immediately follow up with:

```text
Now give me a concrete example of a use case where GraphQL is clearly better.
```

Expected Cursor behavior:

- Second response references the first response context without re-explaining REST vs GraphQL.

Expected Vercel logs:

```text
INJECT_SUMMARY turns: ... hits: ... misses: ... recovered: ...
```

Verify reasoning injection is working (hit count should be non-zero for the second turn).

## Notes

- M3 uses `reasoning_details` (object/array) same as M2.x — no changes to `lib/reasoning.js`.
- M3 is natively multimodal (images and videos). The vision bridge is bypassed for models starting with `minimax-m3`.
- M2.x models are unaffected and continue to use the vision bridge.
- The `thinking: { type: "adaptive" }` parameter is injected only when the client omits it. If the client explicitly sends `thinking: { type: "disabled" }`, the proxy preserves it.