# Azure OpenAI Responses API — Compatibility Tracker

Tracking Cursor ↔ Azure OpenAI Responses API gaps discovered, diagnosed, and fixed via the proxy.

## Purpose

Cursor primarily reaches this proxy through the OpenAI Chat Completions-compatible route, but recent Cursor builds can send native Responses `input` items on that route. Azure Foundry exposes the OpenAI **Responses API** (and Anthropic Messages API). The proxy translates between these formats. When Azure adds event types, tool types, or API surface that the proxy doesn't handle, Cursor can experience silent failures: no client-visible error, just dropped features or a later Azure 400 when `previous_response_id` chaining sees an unmatched tool call.

This file records each gap: the symptom, root cause, fix, and verification diagnostic so future issues are faster to triage.

---

## Fixed

### 1. apply_patch custom tool SSE events silently dropped

| Field | Detail |
|---|---|
| **Date discovered** | 2026-05-08 |
| **Commit** | `6482918` |
| **Symptom** | Cursor model says "ApplyPatch is still failing in this environment, so I'm doing the same tiny edit with a direct file write." gpt-5.x via proxy cannot apply patches. |
| **Root cause** | Cursor sends `{type:"custom", name:"apply_patch", format:{type:"grammar", syntax:"lark", definition:"..."}}` in the tools array. Azure streams `response.custom_tool_call_input.delta` events with the patch data. `mapResponsesSSEToOpenAI()` had no case for this event — it fell through to `default: return null` and was silently dropped. Cursor never received the tool call. |
| **Fix** | Three changes in `api/azure-openai.js` and `api/proxy.js`: |

**Tool normalization** — preserve known Responses native tool definitions instead of converting or dropping them. `custom` was the confirmed production fix; the other native tool types are preserved for request compatibility but do not imply full downstream Cursor integration.

```js
// api/azure-openai.js — AZURE_OPENAI_RESPONSES_TOOL_TYPES set
const AZURE_OPENAI_RESPONSES_TOOL_TYPES = new Set([
  "custom", "web_search", "web_search_preview", "file_search",
  "computer_use_preview", "code_interpreter", "image_generation",
  "mcp", "apply_patch",
]);

// normalizeAzureOpenAITools() — Step 1: preserve known native types
if (isKnownResponsesToolType(tool.type)) {
  filtered.push(tool);
  keptNative++;
  continue;
}
```

**SSE mapper** — add cases for the confirmed custom-tool stream and provisional native apply_patch stream names:

```js
// api/azure-openai.js — mapResponsesSSEToOpenAI()
case "response.custom_tool_call_input.delta": { /* map to tool_calls */ }
case "response.apply_patch_call.delta":        { /* provisional native apply_patch support */ }
case "response.apply_patch_call_input.delta":  { /* provisional native apply_patch support */ }
// response.output_item.added with item.type === "custom_tool_call" || "apply_patch_call"
// .done events for all three
```

**Non-streaming mapper** — handle custom tool items fully; native apply_patch has a case but remains provisional because the documented item shape uses `operation`, not `input`:

```js
// api/azure-openai.js — mapResponsesToOpenAI()
} else if (item.type === "custom_tool_call") { /* map to tool_calls */ }
} else if (item.type === "apply_patch_call") { /* provisional: native item.operation is not faithfully bridged yet */ }
```

**Proxy.js chaining** — recognize custom tool items for KV hash computation:

```js
// api/proxy.js — isAsstItem()
item.type === "custom_tool_call" ||
item.type === "apply_patch_call" ||
// ... 13 other assistant output types ...
```

**Verification diagnostic**: After deploy, search logs for `TOOLS_SHAPE ... knownType:` with non-zero values (confirms custom tools survive normalization) AND `AZURE_STREAM_SUMMARY` entries where `functionArgDeltas` > 0 AND the events dict contains `response.custom_tool_call_input.delta`.

**Scope boundary**: Commit `6482918` fixes Cursor's observed Codex-style custom tool flavor: `{type:"custom", name:"apply_patch", format:{...}}` -> `custom_tool_call` / `custom_tool_call_output`. It does **not** prove full support for OpenAI's newer native apply_patch tool (`tools:[{"type":"apply_patch"}]`), whose documented output item is `apply_patch_call` with an `operation` object and whose reply item is `apply_patch_call_output`.

**Lesson**: The SSE mapper is the single point of failure for streaming Responses API events. Every new Azure event type needs a corresponding case. The non-streaming mapper also needs updating for the same item types.

---

## Known gaps (not yet fixed)

### event: line suppression — unmapped Responses events

`mapResponsesSSEToOpenAI()` has a `default: return null` fallback. Any Azure Responses API event not explicitly listed in the switch is dropped from the downstream Chat Completions stream. Some dropped events are harmless progress/lifecycle events because final text still arrives through `response.output_text.delta`; others are compatibility risks if Cursor expects to see the item or its outputs.

| Event | Status | Notes |
|---|---|---|
| `response.queued` | Dropped | Official lifecycle event; no Chat Completions output today |
| `response.output_item.done` | Counted only, then dropped | No call-site side effect today; risk if a future/native tool exposes final arguments only on the completed item |
| `response.refusal.done` | Dropped | Final refusal text is not emitted; refusal deltas are mapped |
| `response.output_text.annotation.added` | Dropped | Citations/annotations are not bridged to Chat clients |
| `response.reasoning_summary_part.added` | Dropped | Usually acceptable because this proxy strips/suppresses reasoning for Chat clients; verify if Cursor starts consuming reasoning summaries |
| `response.reasoning_summary_text.delta` | Dropped | See above |
| `response.reasoning_summary_text.done` | Dropped | See above |
| `response.reasoning_summary_part.done` | Dropped | See above |
| `response.reasoning_text.delta` | Dropped | Official reasoning text stream; proxy strips/suppresses reasoning today |
| `response.reasoning_text.done` | Dropped | See above |
| `response.content_part.added` | Dropped | Output text still works via `output_text.delta` |
| `response.content_part.done` | Dropped | See above |
| `response.web_search_call.in_progress/searching/completed` | Dropped | Not yet encountered in practice; may be acceptable if only final text/sources are needed |
| `response.file_search_call.in_progress/searching/completed` | Dropped | Not yet encountered in practice; risky when `include:["file_search_call.results"]` is expected downstream |
| `response.code_interpreter_call.in_progress/interpreting/completed` | Dropped | Not yet encountered in practice; risky when `include:["code_interpreter_call.outputs"]` is expected downstream |
| `response.code_interpreter_call_code.delta/done` | Dropped | Code input/output stream is not Chat-bridged |
| `response.image_generation_call.in_progress/generating/partial_image/completed` | Dropped | Image output items are not Chat-bridged |
| `response.mcp_call_arguments.delta/done` | Dropped | MCP argument stream is not Chat-bridged |
| `response.mcp_call.in_progress/completed/failed` | Dropped | Risky if Cursor expects MCP call visibility |
| `response.mcp_list_tools.in_progress/completed/failed` | Dropped | Risky if Cursor expects MCP tool-list visibility |
| `response.audio.*` / `response.audio.transcript.*` | Dropped | Not relevant unless audio output is bridged through this proxy |

### Native apply_patch support is only provisional

OpenAI documents the native `apply_patch` tool as `tools:[{"type":"apply_patch"}]`. Its output item is `apply_patch_call` with an `operation` object (`operation.type`, `operation.path`, `operation.diff`), and the follow-up input item is `apply_patch_call_output` with `call_id`, `status`, and optional `output`.

The current proxy recognizes `apply_patch_call` enough to avoid totally dropping the item, but it maps only `item.input` / `item.patch` to Chat-style function arguments. That is correct for the custom-tool flavor's raw string input, but not faithful for native `apply_patch_call.operation`. Until tested with real Cursor native apply_patch traffic, treat native apply_patch support as a known compatibility gap, not a completed feature.

### Request sanitizer allowlist gaps

The sanitizer now preserves important Responses params such as `prompt`, `include`, `background`, `metadata`, `prompt_cache_key`, `prompt_cache_retention`, `safety_identifier`, `service_tier`, and `text`. It still strips documented Responses create params that are not in the local allowlist, including at least:

| Param | Current proxy behavior | Risk |
|---|---|---|
| `max_tool_calls` | Stripped | Client cannot cap built-in tool calls |
| `conversation` | Stripped | Client cannot use Responses conversation objects through this proxy |

Do not add params blindly; Azure support can lag OpenAI. Add them with a replay test or a production diagnostic when needed.

### Tool types not yet observed

The tool normalization whitelist (`AZURE_OPENAI_RESPONSES_TOOL_TYPES`) includes several tool types that pass through to Azure but whose response/progress events have no dedicated SSE mapper cases:

| Tool type | Passes normalization? | SSE response events handled? | Risk |
|---|---|---|---|
| `custom` | Yes | Yes (6482918) | Fixed for Cursor apply_patch custom flavor |
| `apply_patch` | Yes | Partial/provisional | Native `operation` object is not faithfully bridged |
| `web_search` | Yes | No dedicated mapper | Azure docs note availability can differ; likely final text still arrives |
| `web_search_preview` | Yes | No dedicated mapper | Sources require `include` support and downstream mapping |
| `file_search` | Yes | No dedicated mapper | Results require `include` support and downstream mapping |
| `computer_use_preview` | Yes | No dedicated mapper | Computer call outputs are not Chat-bridged |
| `code_interpreter` | Yes | No dedicated mapper | Outputs require `include` support and downstream mapping |
| `image_generation` | Yes | No dedicated mapper | Image output items are not Chat-bridged |
| `mcp` | Yes | No dedicated mapper | MCP call/list/approval events are not Chat-bridged |

---

## Diagnostic reference

### How to verify a fix was deployed

1. **Export production logs** for the deployment window
2. **Find the diagnostic tag** for the feature (e.g., `TOOLS_SHAPE`, `AZURE_STREAM_SUMMARY`)
3. **Confirm non-zero counts** — a zero count for a feature tag after deploy means the code path never executed
4. **Cross-check both sides**: input (tool normalization logs) AND output (stream summary logs)

### Key diagnostic tags

| Tag | Source | What it tells you |
|---|---|---|
| `TOOLS_SHAPE` | `api/azure-openai.js` | Raw tool format before conversion: total count, format breakdown, knownType count |
| `TOOLS_FIXED` | `api/azure-openai.js` | Post-normalization: kept, dropped, native count |
| `AZURE_STREAM_SUMMARY` | `api/proxy.js` | Per-stream event type counts — look for custom_tool_call events |
| `AZURE_INPUT_SHAPE` | `api/azure-openai.js` | Input item types before/after normalization |
| `STREAM_AZ_RESP_ID` | `api/proxy.js` | Response ID captured from `response.created` |
| `CACHE_AZ_RESP_ID` | `api/proxy.js` | Response ID written to KV |
| `PREV_RESP_ID_FOUND` | `api/proxy.js` | KV hit for previous_response_id chaining |
| `PREV_RESP_ID_MISS` | `api/proxy.js` | KV miss — stateless fallback |

### Apply-patch specific verification

After deploying a fix for apply_patch, confirm ALL of these in production logs:

1. `TOOLS_SHAPE ... knownType: N` where N > 0 (custom tools passed through normalization)
2. `AZURE_STREAM_SUMMARY ... functionArgDeltas: N` where N > 0 for streams that contain `response.custom_tool_call_input.delta` in the events dict
3. No model responses containing "ApplyPatch is still failing" or "direct file write" fallback language
4. `custom_tool_call_output` items appearing in subsequent `AZURE_INPUT_SHAPE` entries (confirms Cursor's runner executed the patch)

For native apply_patch traffic, these diagnostics are not sufficient. Confirm `apply_patch_call` items contain a documented `operation` object and that Cursor returns `apply_patch_call_output` with matching `call_id`.

---

## Documentation references checked

- OpenAI Responses API overview/reference: current public docs are under `developers.openai.com`, not the older `platform.openai.com/docs/guides/responses` URL used earlier in this note.
- OpenAI streaming events reference: `response.custom_tool_call_input.delta` and `response.custom_tool_call_input.done` are official streaming events. No official `response.apply_patch_call.*` streaming event names were found; those mapper cases should remain defensive/provisional unless real Azure traffic proves them.
- OpenAI Apply Patch guide: native tool uses `tools:[{"type":"apply_patch"}]`, returns `apply_patch_call` items with `operation`, and expects `apply_patch_call_output` results.
- OpenAI Responses create reference: documents `background`, `include`, `prompt`, `prompt_cache_key`, `prompt_cache_retention`, `max_tool_calls`, `conversation`, terminal `status` / `incomplete_details`, and built-in tools such as web/file/code/computer/image/MCP.
- Azure OpenAI in Microsoft Foundry Models Responses docs/reference: the proxy-relevant inference surface is `/openai/responses` for the dated preview API and `/openai/v1/responses` for the current v1 API. The Microsoft Foundry project/Agents REST API is useful as a schema cross-check, but is not the primary reference for this proxy's Responses inference route.

---

## Event type reference

### Azure OpenAI Responses API — streaming events

Events that the proxy currently handles, suppresses, or should treat as known official/provisional types:

| SSE Event | Handled by mapper? | Side-effect at call site? | Mapped to OpenAI format? |
|---|---|---|---|
| `response.created` | Returns null | Captures `response.id` for KV | No output |
| `response.queued` | Returns null | None | No output (dropped) |
| `response.in_progress` | Returns null | None | No output |
| `response.output_item.added` | Yes (message, function_call, custom_tool_call, apply_patch_call) | — | `delta.role` or `delta.tool_calls` |
| `response.content_part.added` | Returns null | None | No output (dropped) |
| `response.output_text.delta` | Yes | — | `delta.content` |
| `response.output_text.done` | Returns null | None | No output |
| `response.output_text.annotation.added` | Returns null | None | No output (dropped) |
| `response.content_part.done` | Returns null | None | No output (dropped) |
| `response.output_item.done` | Returns null | Counted only | No output |
| `response.refusal.delta` | Yes | Accumulated for stream summary | `delta.refusal` |
| `response.refusal.done` | Returns null | None | No output |
| `response.function_call_arguments.delta` | Yes | Counted as `azureFunctionDeltaCount` | `delta.tool_calls[{function:{arguments}}]` |
| `response.function_call_arguments.done` | Returns null | None | No output |
| `response.custom_tool_call_input.delta` | Yes (6482918) | Counted as `azureFunctionDeltaCount` | `delta.tool_calls[{function:{arguments}}]` |
| `response.custom_tool_call_input.done` | Returns null | None | No output |
| `response.apply_patch_call.delta` | Defensive/provisional | Counted as `azureFunctionDeltaCount` | Not found in official OpenAI streaming events reference; only useful if Azure emits this observed/provisional shape |
| `response.apply_patch_call_input.delta` | Defensive/provisional | Counted as `azureFunctionDeltaCount` | Not found in official OpenAI streaming events reference; only useful if Azure emits this observed/provisional shape |
| `response.apply_patch_call.done` | Defensive/provisional | None | Not found in official OpenAI streaming events reference |
| `response.apply_patch_call_input.done` | Defensive/provisional | None | Not found in official OpenAI streaming events reference |
| `response.reasoning_summary_part.added` | Returns null | None | No output (dropped) |
| `response.reasoning_summary_text.delta` | Returns null | None | No output (dropped) |
| `response.reasoning_summary_text.done` | Returns null | None | No output (dropped) |
| `response.reasoning_summary_part.done` | Returns null | None | No output (dropped) |
| `response.reasoning_text.delta` | Returns null | None | No output (dropped) |
| `response.reasoning_text.done` | Returns null | None | No output (dropped) |
| `response.file_search_call.in_progress/searching/completed` | Returns null | None | No output (dropped) |
| `response.web_search_call.in_progress/searching/completed` | Returns null | None | No output (dropped) |
| `response.code_interpreter_call.in_progress/interpreting/completed` | Returns null | None | No output (dropped) |
| `response.code_interpreter_call_code.delta/done` | Returns null | None | No output (dropped) |
| `response.image_generation_call.in_progress/generating/partial_image/completed` | Returns null | None | No output (dropped) |
| `response.mcp_call_arguments.delta/done` | Returns null | None | No output (dropped) |
| `response.mcp_call.in_progress/completed/failed` | Returns null | None | No output (dropped) |
| `response.mcp_list_tools.in_progress/completed/failed` | Returns null | None | No output (dropped) |
| `response.audio.*` / `response.audio.transcript.*` | Returns null | None | No output (dropped) |
| `response.completed` | Returns null | Emits `[DONE]`, caches response ID, logs summary | `data: [DONE]` |
| `response.incomplete` | Returns null | Emits `[DONE]`, logs incomplete reason | `data: [DONE]` |
| `response.failed` | Returns null | Not handled (6482918 doesn't cover this) | Would be silently dropped |
| `response.cancelled` | Returns null | Not handled (6482918 doesn't cover this) | Azure/defensive; not found in the OpenAI streaming events reference |

### Azure OpenAI Responses API — non-streaming output item types

| Output item type | Handled by `mapResponsesToOpenAI()`? | Notes |
|---|---|---|
| `message` (role: assistant) | Yes | Mapped to `choices[0].message.content` |
| `function_call` | Yes | Mapped to `choices[0].message.tool_calls[]` |
| `custom_tool_call` | Yes (6482918) | Mapped to `tool_calls[]`, `input` → `arguments` |
| `apply_patch_call` | Partial/provisional | Case exists, but documented native shape uses `operation`; current mapper only checks `input` / `patch` |
| `reasoning` | No | Ignored (reasoning stripped at proxy level) |
| `file_search_call` | No | Silently dropped |
| `web_search_call` | No | Silently dropped |
| `computer_call` | No | Silently dropped |
| `code_interpreter_call` | No | Silently dropped |
| `image_generation_call` | No | Silently dropped |

---

## Official documentation links

Bookmark these for future gap investigations — no need to search again.

### OpenAI Responses API (upstream API surface that Azure Foundry mirrors)

| Resource | URL |
|---|---|
| Responses API overview | `https://developers.openai.com/api/reference/responses/overview/` |
| Migrate to Responses guide | `https://developers.openai.com/api/docs/guides/migrate-to-responses` |
| Create response reference | `https://developers.openai.com/api/reference/resources/responses/methods/create` |
| Streaming guide | `https://developers.openai.com/api/docs/guides/streaming-responses` |
| Responses streaming events (full event type list) | `https://developers.openai.com/api/reference/resources/responses/streaming-events/` |
| Tools / custom tools | `https://developers.openai.com/api/docs/guides/tools` |
| Apply Patch tool | `https://developers.openai.com/api/docs/guides/tools-apply-patch` |

### Azure OpenAI in Microsoft Foundry Models (proxy-relevant inference API)

| Resource | URL |
|---|---|
| Responses API how-to | `https://learn.microsoft.com/azure/foundry/openai/how-to/responses` |
| Dated preview REST reference for current proxy path (`/openai/responses?api-version=2025-04-01-preview`) | `https://learn.microsoft.com/azure/foundry/openai/reference-preview#responses` |
| Current v1 preview REST reference (`/openai/v1/responses?api-version=preview`) | `https://learn.microsoft.com/azure/foundry/openai/reference-preview-latest#create-response` |
| Latest v1 REST reference | `https://learn.microsoft.com/azure/foundry/openai/latest` |
| Model availability | `https://learn.microsoft.com/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure` |

### Azure Foundry project/Agents docs (secondary schema cross-checks only)

| Resource | URL |
|---|---|
| Microsoft Foundry project/Agents REST API reference | `https://learn.microsoft.com/rest/api/aifoundry/aiproject` |
| Azure AI Agent Server Python SDK (Responses models) | `https://learn.microsoft.com/python/api/azure-ai-agentserver-responses/azure.ai.agentserver.responses.models?view=azure-python-preview` |
| Azure AI Agent Server .NET SDK (Responses models) | `https://learn.microsoft.com/dotnet/api/azure.ai.agentserver.responses.models?view=azure-dotnet-preview` |

### Anthropic Messages API (for azureanthropic provider)

| Resource | URL |
|---|---|
| Anthropic Messages API reference | `https://docs.anthropic.com/en/api/messages` |
| Anthropic streaming events | `https://docs.anthropic.com/en/api/messages-streaming` |
| Anthropic tool use | `https://docs.anthropic.com/en/docs/build-with-claude/tool-use` |

### Endpoint/API-surface note

For this proxy's Azure OpenAI provider, the relevant Microsoft docs are **Azure OpenAI in Microsoft Foundry Models** data-plane inference docs. The current proxy path is the dated preview `/openai/responses?api-version=2025-04-01-preview`; the current v1 docs use `/openai/v1/responses?api-version=preview`. Microsoft examples often use `*.openai.azure.com`; existing resources may also use `*.cognitiveservices.azure.com`, and `AZURE_OPENAI_ENDPOINT` can override the endpoint. Do not use the Microsoft Foundry project/Agents REST API as the primary reference for this proxy's `/openai/responses` route.

---

## Update log

| Date | What changed |
|---|---|
| 2026-05-09 | Created tracker. Documented apply_patch fix (6482918), known gaps, event reference tables. |
| 2026-05-09 | Tightened tracker wording: custom apply_patch is confirmed fixed; native apply_patch and built-in tool bridging are marked as compatibility gaps, not completed support. |
| 2026-05-09 | **Production verification:** Deployed 6482918, exported logs (2026-05-09T01:26 UTC). All 13 apply_patch streams show matching `functionArgDeltas` counts (e.g., 71 delta events → 71 counted). `custom_tool_call_output` items appear in subsequent `AZURE_INPUT_SHAPE` entries confirming Cursor's runner executed patches. KV chaining hit rate 90.2% (37/41). Zero errors. |
| 2026-05-09 | **Documentation correction:** Replaced stale `platform.openai.com` guide links with current `developers.openai.com` docs. Reclassified Microsoft references: Azure OpenAI in Microsoft Foundry Models inference docs are primary for this proxy, while Microsoft Foundry project/Agents docs are schema cross-checks only. Confirmed `response.custom_tool_call_input.delta` and `.done` are official streaming events. Confirmed native `apply_patch_call` / `apply_patch_call_output` item shapes are documented, but no official `response.apply_patch_call.*` streaming events were found; current mapper cases remain defensive/provisional. |
