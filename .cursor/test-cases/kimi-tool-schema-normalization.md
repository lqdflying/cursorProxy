# Kimi Tool JSON Schema `$ref` Normalization

## Purpose

Validate that tool `function.parameters` schemas sent to the Kimi/Moonshot provider are normalized so every local `$ref` uses the `#/$defs/` form. Cursor subagents frequently emit Draft-4 `#/definitions/X` or self-references such as `#/properties/foo`, which Moonshot rejects.

## Provider And Model

- Cursor model: `cursorproxy/kimi-k2.7-code` (or any model routed to the `kimi` provider)
- Provider route: `kimi`
- Cursor mode: Agent with subagent / file tools

## Preconditions

- `KIMI_API_KEY` set (Moonshot API key)
- `CURSORPROXY_API_KEY` set
- KV configured (`REDIS_URL`, `KV_URL` + `KV_TOKEN`, or EdgeOne KV binding)
- `CURSORPROXY_MODELS` includes the chosen Kimi model (or is unset)

## Background

Moonshot's API requires all `$ref` values inside `tools.function.parameters` to start with `#/$defs/`. Cursor's subagent tool definitions often contain:

- `#/definitions/...` (JSON Schema Draft-4)
- `#/properties/...` (self-references)
- External URLs such as `https://example.com/schema.json`
- `$ref`-shaped data inside `const`, `default`, `examples`, or `enum`

The proxy must rewrite or remove the non-compliant references before forwarding, while leaving data-value `$ref` strings untouched.

## Test Steps

### Test 1: Subagent with `#/definitions/` references

Start a new chat. Paste a prompt that forces Cursor to call a subagent or built-in tool whose schema uses `#/definitions/` references:

```text
Create a small Python project under .cursor/tmp/kimi-ref-test/ with two files: main.py and utils.py. main.py should import a function from utils.py and print its result.
```
Expected Cursor behavior:

- Subagent / tool loop completes successfully.
- No upstream 400 containing `tools.function.parameters is not a valid moonshot flavored json schema`.

Expected logs (group by `requestId`):

```text
KIMI_BODY_SANITIZED model: kimi-k2.7-code ... toolRefsFixed: 1
```

The upstream request body must contain only `$ref` values starting with `#/$defs/`.

### Test 2: Self-references with `#/properties/`

In the same chat, follow up with:

```text
Refactor utils.py to expose a second helper function and update main.py to call it.
```

Expected Cursor behavior:

- Refactor completes without a schema-related 400.

Expected logs:

```text
KIMI_BODY_SANITIZED model: kimi-k2.7-code ... toolRefsFixed: 1
```

### Test 3: Non-`kimi-*` model name routed to Kimi provider

If your deployment uses a custom model id such as `cursorproxy/moonshot-myapp` that routes to the `kimi` provider, repeat Test 1 with that model.

Expected behavior:

- Tool schemas are still normalized.
- `KIMI_BODY_SANITIZED ... toolRefsFixed: 1` appears.
- Thinking-related sanitization (`temperature` stripping, `max_tokens` floor) is **not** applied to non-thinking model names.

## Negative Signs (bug still present)

- Upstream 400: `tools.function.parameters is not a valid moonshot flavored json schema`
- Upstream 400: `references must start with #/$defs/`
- `$ref` data values inside `const`, `default`, `examples`, or `enum` are rewritten or removed
- Tool schemas are not normalized for model names that do not start with `kimi` but are routed to the `kimi` provider

## Cleanup

Delete the `.cursor/tmp/kimi-ref-test/` directory if it was created.
