# Azure OpenAI Responses: Cursor apply_patch And Chaining

## Purpose

Validate Cursor -> cursorProxy -> Azure OpenAI Responses compatibility for Cursor's Codex-style custom `apply_patch` tool.

This test covers the bug fixed by commit `6482918`: Azure streamed `response.custom_tool_call_input.delta`, the proxy dropped it, Cursor never ran the tool, and the next chained turn failed with `No tool output found for custom tool call ...`.

## Provider And Model

- Cursor model: `cursorproxy/gpt-5.4` or the current Azure OpenAI GPT-5.x proxy model.
- Provider route: `azureopenai`.
- Deployment: Vercel production or a staging deployment with KV enabled.
- Cursor mode: Agent mode with file editing enabled.

Do not use this case for Claude, DeepSeek, Kimi, MiniMax, or Cursor native models. They do not exercise the Azure OpenAI Responses bridge.

Use a Cursor-facing model id that Cursor recognizes as apply-patch capable.
The generic `cursorproxy/gpt-general` alias is not sufficient evidence: the
proxy may rewrite it to an apply-patch-capable deployment upstream, but Cursor
chooses its local tool surface before that rewrite. If logs show
`TOOLS_SHAPE ... knownType: 0` and only `response.output_text.delta` output,
Cursor did not expose the custom/native `apply_patch` tool for that selected
model id.

## Preconditions

- Vercel has deployed the target commit.
- `AZURE_FOUNDRY_API_KEY` and Azure OpenAI endpoint/resource env vars are configured.
- KV is configured so `previous_response_id` chaining can be observed.
- Cursor is pointed at this proxy and can select the Azure OpenAI proxy model.

## Test 1: First apply_patch Tool Call

Start a fresh Cursor chat and paste:

```text
Create a tiny file named .cursor/tmp/apply_patch_probe.txt with exactly this content:

azure responses apply_patch probe v1

Use apply_patch for the edit. Do not use shell commands or direct file writes.
```

Expected Cursor behavior:

- Cursor applies a patch successfully.
- `.cursor/tmp/apply_patch_probe.txt` exists.
- The file content is exactly:

```text
azure responses apply_patch probe v1
```

Expected Vercel logs:

```text
TOOLS_SHAPE ... knownType: 1
APPLY_PATCH_TOOL_SHAPE ... custom: 1
TOOLS_FIXED ... kept: 18 dropped: 0 native: 1
AZURE_STREAM_SUMMARY ... response.custom_tool_call_input.delta ...
AZURE_STREAM_SUMMARY ... functionArgDeltas: N
CACHE_AZ_RESP_ID key: conv:...
RES 200 provider: azureopenai
```

Negative signs:

```text
ApplyPatch is still failing
direct file write
UPSTREAM_ERROR_STATUS 400
No tool output found for custom tool call
```

## Test 2: Chained apply_patch Tool Output

In the same Cursor chat, paste:

```text
Update .cursor/tmp/apply_patch_probe.txt so the content becomes:

azure responses apply_patch probe v2

Again use apply_patch only. Do not use shell commands or direct file writes.
```

Expected Cursor behavior:

- Cursor applies a second patch successfully.
- The file content is exactly:

```text
azure responses apply_patch probe v2
```

Expected Vercel logs:

```text
PREV_RESP_ID_FOUND key: conv:...
INPUT_CHAIN provider: azureopenai inputItems: 1 trimmed: yes prevResp: resp_...
AZURE_INPUT_SHAPE ... itemTypes: custom_tool_call_output:1
UPSTREAM_STATUS 200 provider: azureopenai stream: true
AZURE_RESPONSE_COMPLETED status: completed
RES 200 provider: azureopenai
```

This is the critical regression check. It proves Cursor received the custom tool call, ran `apply_patch`, returned `custom_tool_call_output`, and Azure accepted the output against the previous response.

Negative signs:

```text
PREV_RESP_ID_FOUND ... followed by UPSTREAM_ERROR_STATUS 400
No tool output found for custom tool call
AZURE_INPUT_SHAPE missing custom_tool_call_output
```

## Test 3: Normal Chained Text Turn After Tool Use

In the same Cursor chat, paste:

```text
Reply with exactly:

azure responses chain ok

Do not edit files.
```

Expected Cursor behavior:

- Cursor replies exactly:

```text
azure responses chain ok
```

Expected Vercel logs:

```text
PREV_RESP_ID_FOUND key: conv:...
INPUT_CHAIN provider: azureopenai inputItems: 1 trimmed: yes prevResp: resp_...
UPSTREAM_STATUS 200 provider: azureopenai stream: true
AZURE_RESPONSE_COMPLETED status: completed
RES 200 provider: azureopenai
```

Negative signs:

```text
PREV_RESP_ID_MISS on every follow-up turn
UPSTREAM_ERROR_STATUS 400
previous_response_not_found
No tool output found for custom tool call
```

## Cleanup

After the test, remove:

```text
.cursor/tmp/apply_patch_probe.txt
```

## Notes

- `response.custom_tool_call_input.delta` is expected for Cursor's current custom-tool flavor.
- Native OpenAI `tools:[{"type":"apply_patch"}]` is not fully validated by this case; see `.cursor/notes/azure-openai-responses-compatibility.md`.
- If `TOOLS_SHAPE ... knownType: 1` or `APPLY_PATCH_TOOL_SHAPE` is absent, Cursor may not have sent the custom tool definition, the selected client-facing model id may not expose apply-patch tools, or the request may not have routed through Azure OpenAI.
