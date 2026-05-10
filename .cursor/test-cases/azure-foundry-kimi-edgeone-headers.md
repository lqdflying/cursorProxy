# Azure Foundry Kimi EdgeOne Header Isolation

## Purpose

Validate that Kimi requests routed to an Azure Foundry OpenAI-compatible endpoint
avoid EdgeOne's `431 Request Header Fields Too Large` failure by forwarding only a
minimal upstream header set and using the Azure hostname as `Host`.

## Provider And Model

- Cursor model: `cursorproxy/Kimi-K2.6` (use the exact Azure deployment name/case)
- Provider route: inferred `kimi` from model prefix
- Deployment: Azure Foundry Kimi deployment exposed through the Kimi provider
- Cursor mode: Ask or Agent; streaming can be enabled

## Preconditions

- Required env vars:
  - `UPSTREAM_KIMI=https://<resource>.services.ai.azure.com/openai`
  - `KIMI_API_KEY=<azure-foundry-key>`
  - `CURSORPROXY_MODELS=Kimi-K2.6`
  - `DEBUG=true` if you need `UPSTREAM` and `UPSTREAM_REQUEST_DUMP` log detail
- Required deployment state: EdgeOne Pages deployment includes the Azure Foundry Kimi header-isolation fix
- Required files or workspace state: none

## Test Steps

Paste this prompt into Cursor through the EdgeOne domain:

```text
Reply with exactly: edgeone azure kimi ok
```

Expected Cursor behavior:

- The model replies successfully.
- Cursor does not show HTTP 431.

Expected file/content changes, if any:

- None.

Expected Vercel/EdgeOne logs:

```text
[cursorProxy:proxy] REQ POST /api/proxy provider: infer
[cursorProxy:proxy] MODEL_STRIP from: cursorproxy/Kimi-K2.6 to: Kimi-K2.6
[cursorProxy:proxy] RESOLVED model: cursorproxy/Kimi-K2.6 provider: kimi stream: <true|false>
[cursorProxy:proxy] UPSTREAM https://<resource>.services.ai.azure.com/openai/v1/chat/completions provider: kimi
[cursorProxy:proxy] UPSTREAM_REQUEST_DUMP url: https://<resource>.services.ai.azure.com/openai/v1/chat/completions method: POST headers: {"accept-encoding":"identity","authorization":"***","content-type":"application/json","host":"<resource>.services.ai.azure.com"} ...
[cursorProxy:proxy] UPSTREAM_STATUS 200 provider: kimi stream: <true|false>
[cursorProxy:proxy] RES 200 provider: kimi ms: <duration>
```

Request grouping checks:

- The `UPSTREAM` URL must contain exactly one `/openai/v1/chat/completions` sequence.
- `UPSTREAM_REQUEST_DUMP` headers must not include `cookie`, EdgeOne trace headers, original client `authorization`, original client `x-api-key`, or `host: api.moonshot.ai`.
- `host` must be `<resource>.services.ai.azure.com`.

Negative signs:

```text
UPSTREAM_ERROR_STATUS 431 provider: kimi body:
host":"api.moonshot.ai"
"cookie":
"x-edgeone
/openai/v1/v1/chat/completions
/openai/v1//v1/chat/completions
```

## Cleanup

No files are created. Turn `DEBUG` back off after validation if it was enabled.

## Notes

- Keep `UPSTREAM_KIMI` at `https://<resource>.services.ai.azure.com/openai` with the current URL builder, because the proxy still appends `/v1/<path>` itself.
- This test focuses on EdgeOne because that runtime can add enough incoming headers to trigger Azure's HTTP 431 response if the proxy forwards them upstream.
