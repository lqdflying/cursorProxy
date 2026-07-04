# OpenAI-Compatible Chat Mode: apply_patch Tool

## Purpose

Validate that Cursor -> cursorProxy -> an OpenAI-compatible Chat Completions gateway can successfully invoke Cursor's `apply_patch` editing tool when `OPENAICOMPAT_WIRE_API=chat`.

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

Use apply_patch for the edit. Do not use shell commands or direct file writes.
```

Expected Cursor behavior:

- Cursor applies a patch successfully.
- `.cursor/tmp/openaicompat_chat_apply_patch_probe.txt` exists.
- The file content is exactly:

```text
openaicompat chat apply_patch probe v1
```

Expected proxy logs:

```text
COMPATIBLE_ALIAS_RESOLVED alias: compatible-gpt-5.5 upstream: gpt-5.5
OPENAICOMPAT_TOOLS_FIXED provider: openaicompat count: 18
UPSTREAM https://<your-upstream>/v1/chat/completions provider: openaicompat
STREAM_DONE ...
RES 200 provider: openaicompat ms: ...
```

Negative signs:

```text
ApplyPatch is still failing
apply patch no response
direct file write
UPSTREAM_ERROR_STATUS 400
```

## Cleanup

After the test, remove:

```text
.cursor/tmp/openaicompat_chat_apply_patch_probe.txt
```

## Notes

- Chat mode wraps Cursor's native Responses `custom` `apply_patch` tool into an OpenAI `function` tool with a synthesized `create_file`/`update_file`/`delete_file` operation schema.
- If the upstream gateway supports `/v1/responses` and HTTP `previous_response_id`, prefer `OPENAICOMPAT_WIRE_API=responses` for fully native apply_patch behavior.
