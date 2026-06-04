# cursorProxy — Multi-Provider Reasoning & Vision Proxy

A lightweight proxy for **DeepSeek**, **Kimi**, **MiniMax**, **Xiaomi MiMo**, and **Azure Foundry** APIs. Deploy on Vercel Edge, self-host via Docker, or run on **EdgeOne Pages**.

- **Reasoning bridge:** caches and injects provider-specific reasoning (DeepSeek/Kimi/MiMo `reasoning_content`, MiniMax `reasoning_details`) by conversation position, including race-tolerant handling for fast follow-up and parallel tool calls.
- **Azure Responses chaining:** caches Azure OpenAI response IDs in KV so subsequent turns use `previous_response_id` instead of resending the full conversation, cutting reasoning-token costs significantly.
- **Claude thinking cache:** caches Claude adaptive-thinking blocks in KV (typed-canonical hash) so multi-turn conversations reuse prior reasoning instead of re-thinking from scratch.
- **Vision bridge:** automatically converts inline images to text descriptions for models that don't support vision natively (DeepSeek, MiniMax M2.x, MiMo Pro/Flash/TTS). MiniMax M3, MiMo `mimo-v2.5`, and `mimo-v2-omni` accept images natively.
- **Format adapters:** Cursor speaks OpenAI Chat Completions; the proxy translates request bodies and SSE streams to/from Azure OpenAI Responses and Azure Anthropic Messages.
- **Model discovery:** exposes `GET /v1/models` from your configured `CURSORPROXY_MODELS` list so clients can discover available model IDs.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/lqdflying/cursorProxy)

---

## Quick Start

### 1. Get API keys
- [DeepSeek](https://platform.deepseek.com) → `DEEPSEEK_API_KEY`
- [Kimi](https://platform.moonshot.ai) → `KIMI_API_KEY` (for Azure Foundry Kimi, see the `UPSTREAM_KIMI` reminder below)
- [MiniMax](https://platform.minimax.io) → `MINIMAX_API_KEY`
- [Xiaomi MiMo](https://platform.xiaomimimo.com) → `MIMO_API_KEY`
- [Azure Foundry](https://ai.azure.com) → `AZURE_FOUNDRY_API_KEY` + `AZURE_FOUNDRY_RESOURCE`
- Generate a proxy secret: `openssl rand -hex 32` → `CURSORPROXY_API_KEY`

### 2. Set up KV storage
- **Vercel:** create a free [Upstash](https://upstash.com) database → `KV_URL` + `KV_TOKEN`
- **Docker:** add `REDIS_URL=redis://redis:6379` to your `.env`
- **EdgeOne Pages:** create a KV namespace in the console and bind it with variable name `cursorproxy_kv`

On EdgeOne, `GET /health` should return `"kv":{"backend":"edgeone","available":true,...}` after deployment.

> [!IMPORTANT]
> **KV is required for multi-turn quality, but its absence is a silent degradation, not a hard failure.** Without a configured backend the proxy still answers requests, but every turn re-pays the reasoning cost from scratch (DeepSeek/Kimi/MiniMax/MiMo), Azure OpenAI cannot chain via `previous_response_id`, Claude rethinks adaptive turns, and image descriptions are recomputed. Docker logs `kv backend: NONE` at boot, and `/health` exposes a `kv` block (`available: false`, `backend: null`) so this is visible from an external check.

### 3. Deploy

```bash
# Docker one-liner
docker run -d --pull always -p 127.0.0.1:3000:3000 --env-file .env lqdflying/cursorproxy:latest
```

### Docker Compose (with Redis + log rotation)

```bash
cp .env.example .env
# Edit .env with your API keys, then:
docker compose up -d
```

See [Deployment](https://github.com/lqdflying/cursorProxy/wiki/Deployment) for Vercel, EdgeOne Pages, 1Panel, and Nginx reverse proxy.

> [!NOTE]
> **Log control.** `docker-compose.yml` caps container logs at 10 MiB × 3 rotated files per service. Set `DEBUG=true` in `.env` only for troubleshooting — it enables per-request access logs and verbose proxy internals. For `docker run`, add `--log-opt max-size=10m --log-opt max-file=3`.
>
> **EdgeOne KV.** EdgeOne Pages exposes KV bindings to Cloud Functions. The API entry points live under `cloud-functions/` so both KV bindings and `console.log` output are available in EdgeOne Pages Log Analysis.

### 4. Configure Cursor

| Field | Value |
|---|---|
| Base URL | `https://<your-host>/v1` |
| API Key | Your `CURSORPROXY_API_KEY` |
| Model | Discovered from `GET /v1/models` when `CURSORPROXY_MODELS` is set, or manually entered |

The proxy exposes configured model IDs with a `cursorproxy/` prefix (for example, `cursorproxy/gpt-5.5`) while forwarding the bare model/deployment name upstream. Configure `CURSORPROXY_MODELS` without prefixes; manually entered bare IDs are also accepted.

---

## Essential Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CURSORPROXY_API_KEY` | Recommended | Client auth secret |
| `CURSORPROXY_MODELS` | Optional | Comma- or newline-separated bare model IDs. `GET /v1/models` returns them as `cursorproxy/<model>` |
| `DEEPSEEK_REASONING_EFFORT` | Optional | DeepSeek thinking effort: `high` (default) or `max` |
| `DEEPSEEK_API_KEY` | For DeepSeek | Upstream API key |
| `KIMI_API_KEY` | For Kimi | Upstream Kimi API key. For Azure Foundry Kimi routed through the `kimi` provider, set this to the Azure Foundry key |
| `UPSTREAM_KIMI` | Optional | Kimi upstream base URL. Defaults to Moonshot (`https://api.moonshot.ai`). **Current-code Azure Foundry Kimi workaround:** set this to `https://<resource>.services.ai.azure.com/openai` (without trailing `/v1/`) because the proxy appends `/v1/<path>` itself |
| `MINIMAX_API_KEY` | For MiniMax | Upstream API key (also used for vision) |
| `MIMO_API_KEY` | For MiMo | Upstream Xiaomi MiMo API key ([platform.xiaomimimo.com](https://platform.xiaomimimo.com)) |
| `UPSTREAM_MIMO` | Optional | MiMo upstream base URL. Default: `https://api.xiaomimimo.com`. Token Plan subscribers can set `https://token-plan-cn.xiaomimimo.com` |
| `AZURE_FOUNDRY_API_KEY` | For Azure Foundry | Upstream API key (used as `api-key` for OpenAI, `x-api-key` for Anthropic) |
| `AZURE_FOUNDRY_RESOURCE` | For Azure Foundry | Resource name (e.g. `quand-mos8to0k-eastus2`) |
| `AZURE_OPENAI_API_VERSION` | For Azure Foundry | Azure OpenAI Responses API version (default `2025-04-01-preview`) |
| `AZURE_OPENAI_ENDPOINT` | Optional | Override Azure OpenAI base URL (Responses API: `/openai/responses`) |
| `AZURE_ANTHROPIC_ENDPOINT` | Optional | Override Azure Anthropic base URL |
| `AZURE_OPENAI_REASONING_EFFORT` | Optional | Force `reasoning.effort` for Azure OpenAI reasoning models, overriding client values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` (model support varies) |
| `AZURE_OPENAI_GENERAL_ALIAS_TARGET` | Optional | Real Azure OpenAI deployment that the public alias `cursorproxy/gpt-general` resolves to (e.g. `gpt-5.5-mini`). Required when clients use the alias |
| `AZURE_OPENAI_GENERAL_REASONING_EFFORT` | Optional | Alias-only override of `reasoning.effort` when clients route through `cursorproxy/gpt-general`. Precedence: alias env > `AZURE_OPENAI_REASONING_EFFORT` > client value |
| `AZURE_ANTHROPIC_THINKING` | Optional | Default Claude thinking mode when request omits it: `adaptive` or `disabled`. **Unset:** the proxy adds no `thinking` field and Azure Anthropic applies its own default. |
| `AZURE_ANTHROPIC_EFFORT` | Optional | Default Claude effort when request omits it: `low`, `medium`, `high`, or `max`. **Unset:** no `output_config.effort` is injected and the upstream default applies. |
| `VISION_API_KEY` | Required when `VISION_API_PROVIDER=openai` | Vision provider API key. For the default `minimax_vl` provider, `MINIMAX_API_KEY` is reused — no separate var needed. |
| `KV_URL` / `KV_TOKEN` | Vercel: yes | Upstash Redis REST credentials |
| `REDIS_URL` | Docker: recommended | Local Redis URL |
| `EDGEONE_KV_BINDING` | EdgeOne: no | KV namespace binding variable name (default `cursorproxy_kv`) |
| `KV_FETCH_TIMEOUT_MS` | Optional | Upstash REST request timeout in ms. Defaults to `UPSTREAM_CONNECT_TIMEOUT_MS`, or 8000 if neither is set. Set 0 to disable. |
| `KV_IMAGE_TTL_SECONDS` | Optional | TTL for the vision/image-description cache (`img:*` keys). Default 7 days. Conversation entries continue to use `KV_TTL_SECONDS` (default 2h). |
| `STREAM_TIMEOUT_SECONDS` | Optional | Stream wall-clock cap. Defaults: 280 on Vercel; 110 on EdgeOne Cloud Functions (under the 120s maxDuration); disabled on Docker. Negative or non-numeric values are rejected with a log warning and the platform default applies. |
| `PRESTREAM_BUDGET_MS` | Optional (Vercel only) | If pre-stream work (reasoning injection + vision conversion) exceeds this, return `504 prestream_timeout` rather than be killed by the platform at ~25s. Default 22000. |

### Azure Foundry Kimi reminder: `cursorproxy/Kimi-K2.6`

Azure Foundry's official Kimi sample shows the OpenAI-compatible base URL as
`https://<resource>.services.ai.azure.com/openai/v1/`. With the current generic
Kimi provider code, `UPSTREAM_KIMI` is treated as the base before the proxy adds
`/v1/chat/completions`, so configure it without the final `/v1/`:

```env
UPSTREAM_KIMI=https://<resource>.services.ai.azure.com/openai
KIMI_API_KEY=<your-azure-foundry-key>
CURSORPROXY_MODELS=Kimi-K2.6
```

Do **not** set `UPSTREAM_KIMI` to the full official `/openai/v1/` base unless the
proxy URL builder is changed; otherwise the upstream URL becomes
`/openai/v1/v1/chat/completions` (or `/openai/v1//v1/chat/completions`) and Azure
returns `404 Resource not found`. Use the exact Azure deployment name/case, such
as `Kimi-K2.6`.

This URL setting avoids the duplicated `/v1` path. The proxy also isolates
outgoing headers for Azure Foundry Kimi, so EdgeOne/CDN/Cookie headers are not
forwarded upstream and the `Host` header is the Azure hostname. If you still see
HTTP `431`, redeploy the header-isolation fix and verify `UPSTREAM_REQUEST_DUMP`
shows only the minimal upstream headers.

### Azure OpenAI alias: `cursorproxy/gpt-general`

`cursorproxy/gpt-general` is a fixed public alias that routes to a real Azure
OpenAI deployment chosen via `AZURE_OPENAI_GENERAL_ALIAS_TARGET`. The proxy
rewrites `parsedBody.model` to the resolved deployment before forwarding, but
the response `model` field stays as `cursorproxy/gpt-general` so clients see
the alias they asked for. `AZURE_OPENAI_GENERAL_REASONING_EFFORT`, when set,
overrides the global `AZURE_OPENAI_REASONING_EFFORT` for requests that route
through this alias only. To advertise the alias via `GET /v1/models`, also
add `gpt-general` (or `cursorproxy/gpt-general`) to `CURSORPROXY_MODELS`.

### MiniMax M3

MiniMax M3 is a natively multimodal model with 1M context window. Unlike M2.x models, it accepts images and videos directly — the vision bridge is automatically bypassed.

**Model IDs are case-sensitive.** Use `MiniMax-M3` (not `minimax-m3` or `MINIMAX-M3`). The proxy forwards the model name exactly as provided to the MiniMax API.

```env
CURSORPROXY_MODELS=MiniMax-M3
```

The proxy automatically injects `thinking: { type: "adaptive" }` when the client omits it, enabling the model's reasoning capabilities. If the client explicitly sends a `thinking` parameter, the proxy preserves it.

**Key differences from M2.x:**
- **Native vision:** Images and videos are forwarded directly to MiniMax (no conversion to text)
- **Thinking mode:** Supports `adaptive` (default) or `disabled`
- **Context window:** 1M tokens (vs 204K for M2.x)

Full reference: [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration).

---

## Wiki

- [Deployment](https://github.com/lqdflying/cursorProxy/wiki/Deployment) — Step-by-step: Vercel, Docker, Compose, 1Panel, Nginx
- [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration) — Every env var, routing logic, Cursor setup
- [Advanced Usage](https://github.com/lqdflying/cursorProxy/wiki/Advanced-Usage-for-CursorProxy) — OAI VSCode Plugin and other OpenAI-compatible clients
- [Architecture](https://github.com/lqdflying/cursorProxy/wiki/Architecture) — Request flow, TLS, file structure
- [Development](https://github.com/lqdflying/cursorProxy/wiki/Development) — Contributing, adding providers

## In-repo docs

- [doc/known-issues.md](doc/known-issues.md) — Cursor-side bugs and workarounds (vision, apply_patch, etc.)
- [doc/architecture-overview.md](doc/architecture-overview.md) — Request flow at a glance
- [doc/kv-caching.md](doc/kv-caching.md) — What is cached, how invalidation works
- [doc/reasoning-bridge.md](doc/reasoning-bridge.md) — DeepSeek / Kimi / MiniMax reasoning injection
- [doc/vision-bridge.md](doc/vision-bridge.md) — Image-to-text conversion for non-vision providers

---

## License

MIT
