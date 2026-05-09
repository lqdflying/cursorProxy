# Cursor Manual Test Cases

This folder contains prompt-based test cases to run through Cursor after proxy changes.

Use these cases when validating provider/model behavior on a deployed proxy, especially Vercel production where streaming, KV, and provider logs are observable.

## Index

| Test case | Purpose |
|---|---|
| [Template](TEMPLATE.md) | Required shape for future Cursor manual test cases. |
| [Azure OpenAI Responses apply_patch](azure-openai-responses-apply-patch.md) | Verifies Cursor -> proxy -> Azure OpenAI Responses custom `apply_patch` tool calls, tool outputs, and `previous_response_id` chaining. |

## Maintenance Rule

Any model/provider bug fix or feature must update this folder when the behavior can be exercised from Cursor. See `.cursor/rules/cursor-test-cases.mdc`.
