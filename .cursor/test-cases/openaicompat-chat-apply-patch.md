# OpenAI-Compatible Chat Mode: apply_patch Fallback

## Purpose

Validate that Cursor can still edit files through `openaicompat` Chat Completions mode when Cursor sends its native Responses `apply_patch` tool.

Because `apply_patch` is a Responses API built-in and Chat Completions models do not reliably call a function named `apply_patch`, cursorProxy **drops** the tool in Chat mode. Cursor then falls back to its standard Chat-mode editing tools (`edit_file`, `search_replace`, `write`).

## Provider And Model

- Cursor model: `cursorproxy/compatible-gpt-5.5` (or any apply-patch-capable model alias routed to `openaicompat`).
- Provider route: `openaicompat`.
- Deployment: Docker/Vercel/EdgeOne with `OPENAICOMPAT_WIRE_API=chat` and `OPENAICOMPAT_CHAT_CACHE_MODE=remote`.

## Preconditions

- `UPSTREAM_OPENAICOMPAT`, `OPENAICOMPAT_API_KEY`, and `OPENAICOMPAT_CHAT_CACHE_MODE=remote` are configured.
- `OPENAICOMPAT_WIRE_API=chat`.
- KV is **not** required for Chat remote mode.

## Test

Start a fresh Cursor chat and paste:

```text
Create a tiny file named .cursor/tmp/openaicompat_chat_apply_patch_probe.txt with exactly this content:

openaicompat chat apply_patch probe v1
```

Expected Cursor behavior:

- Cursor creates the file successfully (via `edit_file`, `search_replace`, `write`, or another standard editing tool).
- `.cursor/tmp/openaicompat_chat_apply_patch_probe.txt` exists.
- The file content is exactly:

```text
openaicompat chat apply_patch probe v1
```

Expected proxy logs:

```text
COMPATIBLE_ALIAS_RESOLVED alias: compatible-gpt-5.5 upstream: gpt-5.5
OPENAICOMPAT_APPLY_PATCH_DROPPED provider: openaicompat reason: chat_mode
OPENAICOMPAT_TOOLS_FIXED provider: openaicompat count: 17
UPSTREAM https://<your-upstream>/v1/chat/completions provider: openaicompat
STREAM_DONE ...
RES 200 provider: openaicompat ms: ...
```

Negative signs:

```text
ApplyPatch is still failing
apply patch no response
UPSTREAM_ERROR_STATUS 400
```

## Cleanup

After the test, remove:

```text
.cursor/tmp/openaicompat_chat_apply_patch_probe.txt
```

## Notes

- `apply_patch` is a Responses API built-in tool. It is not a standard Chat Completions function tool and is not reliably callable by Chat Completions models.
- If you need native `apply_patch` behavior, use `OPENAICOMPAT_WIRE_API=responses` with a gateway that supports `/v1/responses` and HTTP `previous_response_id`.
