# Cursor Manual Test Cases

This folder contains prompt-based test cases to run through Cursor after proxy changes.

Use these cases when validating provider/model behavior on a deployed proxy, especially Vercel production where streaming, KV, and provider logs are observable.

## Index

| Test case | Purpose |
|---|---|
| [Template](TEMPLATE.md) | Required shape for future Cursor manual test cases. |
| [Azure OpenAI Responses apply_patch](azure-openai-responses-apply-patch.md) | Verifies Cursor -> proxy -> Azure OpenAI Responses custom `apply_patch` tool calls, tool outputs, and `previous_response_id` chaining. |
| [OpenAI-compatible Chat cache modes](openaicompat-chat-cache-modes.md) | Verifies `passthrough`, `facade`, and `remote` Chat-mode behavior for OpenAI-compatible gateways. |
| [Kimi K2.7 Code](kimi-k2.7-code.md) | Kimi K2.7 Code request sanitization, reasoning bridge multi-turn inject, and tool-loop `reasoning_content` round-trip. |
| [GLM-5.2 Coding Plan](glm-5.2.md) | GLM routing, Coding Plan URL construction, sanitizer, preserved thinking, tool streaming, and vision bridge behavior. |
| [MiMo basic](mimo-basic.md) | MiMo routing, forced thinking injection, upstream URL, successful completion. |
| [MiMo reasoning cache](mimo-reasoning-cache.md) | Multi-turn `reasoning_content` KV inject on MiMo. |
| [MiMo vision routing](mimo-vision-routing.md) | Vision bridge on Pro vs native images on `mimo-v2.5`. |

## Maintenance Rule

Any model/provider bug fix or feature must update this folder when the behavior can be exercised from Cursor. See `.cursor/rules/cursor-test-cases.mdc`.
