# cursorProxy — Multi-Provider Reasoning & Vision Proxy

A lightweight proxy for **DeepSeek**, **Kimi**, **MiniMax**, **Xiaomi MiMo**, **GLM / ZHIPU AI**, **Fireworks AI**, and **Azure Foundry** APIs. Deploy on Vercel Edge, self-host via Docker, or run on **EdgeOne Pages**.

- **Reasoning bridge:** caches and injects provider-specific reasoning (DeepSeek/Kimi/MiMo/GLM `reasoning_content`, MiniMax `reasoning_details`) by conversation position, including race-tolerant handling for fast follow-up and parallel tool calls.
- **Responses chaining:** caches Azure OpenAI and supported OpenAI-compatible Responses API response IDs in KV so subsequent turns can use `previous_response_id` instead of resending the full conversation, cutting reasoning-token costs significantly where the upstream supports HTTP chaining.
- **Claude thinking cache:** caches Claude adaptive-thinking blocks in KV (typed-canonical hash) so multi-turn conversations reuse prior reasoning instead of re-thinking from scratch.
- **Vision bridge:** automatically converts inline images to text descriptions for models that don't support vision natively (DeepSeek, MiniMax M2.x, MiMo Pro/Flash/TTS, GLM-5.2). MiniMax M3, MiMo `mimo-v2.5`, `mimo-v2-omni`, and allowlisted visual GLM models accept images natively.
- **Format adapters:** Cursor speaks OpenAI Chat Completions; the proxy translates request bodies and SSE streams to/from Azure OpenAI Responses and Azure Anthropic Messages.
- **Model discovery:** exposes `GET /v1/models` from your configured `CURSORPROXY_MODELS` list so clients can discover available model IDs.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/lqdflying/cursorProxy)

---

## Quick Start

### 1. Get API keys
- [DeepSeek](https://platform.deepseek.com) → `DEEPSEEK_API_KEY`
- [Kimi](https://platform.moonshot.ai) → `KIMI_API_KEY` (for Azure Foundry Kimi, see the [Azure wiki](https://github.com/lqdflying/cursorProxy/wiki/Azure))
- [MiniMax](https://platform.minimax.io) → `MINIMAX_API_KEY`
- [Xiaomi MiMo](https://platform.xiaomimimo.com) → `MIMO_API_KEY`
- [ZHIPU AI / Z.AI](https://open.bigmodel.cn) → `GLM_API_KEY`
- [Fireworks AI](https://fireworks.ai) → `FIREWORKS_API_KEY` (open-source model hosting)
- [Azure Foundry](https://ai.azure.com) → `AZURE_FOUNDRY_API_KEY` + `AZURE_FOUNDRY_RESOURCE`
- Generate a proxy secret: `openssl rand -hex 32` → `CURSORPROXY_API_KEY`

### 2. Set up KV storage
- **Vercel:** create a free [Upstash](https://upstash.com) database → `KV_URL` + `KV_TOKEN`
- **Docker:** add `REDIS_URL=redis://redis:6379` to your `.env`
- **EdgeOne Pages:** create a KV namespace in the console and bind it with variable name `cursorproxy_kv`

On EdgeOne, `GET /health` should return `"kv":{"backend":"edgeone","available":true,...}` after deployment.

> [!IMPORTANT]
> **KV is required for multi-turn quality, but its absence is a silent degradation, not a hard failure.** Without a configured backend the proxy still answers requests, but every turn re-pays the reasoning cost from scratch (DeepSeek/Kimi/MiniMax/MiMo), Azure OpenAI and OpenAI-compatible Responses mode cannot chain via `previous_response_id`, Claude rethinks adaptive turns, and image descriptions are recomputed. Docker logs `kv backend: NONE` at boot, and `/health` exposes a `kv` block (`available: false`, `backend: null`) so this is visible from an external check.

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

Keep this table to values you must set for the deployment and providers you actually use. Optional tuning, upstream overrides, aliases, model discovery, and vision-provider switches are documented in the [Environment Variables](https://github.com/lqdflying/cursorProxy/wiki/Environment-Variables) wiki page.

| Variable | Required when | Description |
|---|---|---|
| `CURSORPROXY_API_KEY` | Production use | Client auth secret. Use this in Cursor's API key field. |
| `DEEPSEEK_API_KEY` | Using DeepSeek models | Upstream DeepSeek API key. |
| `KIMI_API_KEY` | Using Kimi models | Upstream Moonshot/Kimi API key. |
| `MINIMAX_API_KEY` | Using MiniMax models or default vision bridge | Upstream MiniMax API key; also reused by the default MiniMax VL vision backend. |
| `MIMO_API_KEY` | Using Xiaomi MiMo models | Upstream MiMo API key. |
| `GLM_API_KEY` | Using GLM / ZHIPU / Z.AI models | Upstream GLM API key. |
| `FIREWORKS_API_KEY` | Using Fireworks AI models | Upstream Fireworks API key. |
| `AZURE_FOUNDRY_API_KEY` | Using Azure OpenAI or Azure Anthropic | Azure Foundry API key. |
| `AZURE_FOUNDRY_RESOURCE` | Using Azure OpenAI or Azure Anthropic | Azure Foundry resource name. |
| `KV_URL` + `KV_TOKEN` | Vercel deployment | Upstash Redis REST credentials for reasoning, response-id, and image caches. |
| `REDIS_URL` | Docker with local Redis | Local Redis URL, usually `redis://redis:6379`. |
| EdgeOne KV binding | EdgeOne Pages deployment | Bind a KV namespace as `cursorproxy_kv` in the EdgeOne console. |

Common optional settings:

- `CURSORPROXY_MODELS` advertises model IDs from `GET /v1/models`.
- `UPSTREAM_GLM=https://api.z.ai/api/coding/paas/v4` switches GLM from the default China Coding Plan endpoint to global Z.AI.
- `UPSTREAM_KIMI`, `UPSTREAM_MIMO`, `UPSTREAM_FIREWORKS`, Azure aliases, reasoning effort, timeout, TTL, and vision-provider settings are covered in the wiki.
- `OPENAICOMPAT_WIRE_API=responses` switches the openai-compatible provider from Chat Completions (default) to the OpenAI Responses API with `previous_response_id` state chaining. For GPT-5.6 Sol, optional `OPENAICOMPAT_REASONING_EFFORT=max` selects the highest supported single-model reasoning effort, at higher cost and latency; model and upstream support varies. `ultra` is not an effort value. Requires a KV backend. See [Compatible Providers](https://github.com/lqdflying/cursorProxy/wiki/Compatible-Providers).
- `compatible-gpt-5.6` is a Responses-mode alias for compatible upstreams that expose `gpt-5.6-sol`, OpenAI's flagship GPT-5.6 model (also targeted by the `gpt-5.6` alias). Use `OPENAICOMPAT_WIRE_API=responses`; Chat mode forwards the same upstream model to `/v1/chat/completions` and will fail if the provider only supports GPT-5.6 on `/v1/responses`.

Full references:

- [Environment Variables](https://github.com/lqdflying/cursorProxy/wiki/Environment-Variables)
- [Provider Behavior](https://github.com/lqdflying/cursorProxy/wiki/Provider-Behavior)
- [Azure](https://github.com/lqdflying/cursorProxy/wiki/Azure)

---

## Wiki

- [Deployment](https://github.com/lqdflying/cursorProxy/wiki/Deployment) — Vercel, Docker, Compose, EdgeOne, 1Panel, and Nginx setup
- [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration) — API keys, Cursor setup, routing, and model discovery
- [Environment Variables](https://github.com/lqdflying/cursorProxy/wiki/Environment-Variables) — Full user-facing env var reference
- [Provider Behavior](https://github.com/lqdflying/cursorProxy/wiki/Provider-Behavior) — Provider-specific behavior and model caveats
- [Azure](https://github.com/lqdflying/cursorProxy/wiki/Azure) — Azure Foundry setup, aliases, and troubleshooting
- [Compatible Providers](https://github.com/lqdflying/cursorProxy/wiki/Compatible-Providers) — Generic OpenAI- and Anthropic-compatible endpoints
- [Known Issues](https://github.com/lqdflying/cursorProxy/wiki/Known-Issues) — Cursor-side limitations and workarounds
- [Advanced Usage](https://github.com/lqdflying/cursorProxy/wiki/Advanced-Usage-for-CursorProxy) — OAI VSCode Plugin and other OpenAI-compatible clients
- [Architecture](https://github.com/lqdflying/cursorProxy/wiki/Architecture) — User-facing request flow, routing, TLS, and deployment modes

## In-repo docs

- [doc/known-issues.md](doc/known-issues.md) — Cursor-side bugs and workarounds (vision, apply_patch, etc.)
- [doc/architecture-overview.md](doc/architecture-overview.md) — Request flow at a glance
- [doc/kv-caching.md](doc/kv-caching.md) — What is cached, how invalidation works
- [doc/reasoning-bridge.md](doc/reasoning-bridge.md) — DeepSeek / Kimi / MiniMax / MiMo / GLM reasoning injection
- [doc/vision-bridge.md](doc/vision-bridge.md) — Image-to-text conversion for text-only providers

---

## License

MIT
