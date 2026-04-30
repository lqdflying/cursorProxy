# cursorProxy — Multi-Provider Reasoning & Vision Proxy

A lightweight proxy for **DeepSeek**, **Kimi**, and **MiniMax** APIs. Deploy on Vercel Edge, self-host via Docker, or run on **EdgeOne Pages**.

- **Reasoning bridge:** caches and injects provider-specific reasoning by conversation position, including race-tolerant handling for fast follow-up and parallel tool calls.
- **Vision bridge:** automatically converts inline images to text descriptions for models that don't support vision natively.
- **Model discovery:** exposes `GET /v1/models` from your configured `CURSORPROXY_MODELS` list so clients can discover available model IDs.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/lqdflying/cursorProxy)

---

## Quick Start

### 1. Get API keys
- [DeepSeek](https://platform.deepseek.com) → `DEEPSEEK_API_KEY`
- [Kimi](https://platform.moonshot.ai) → `KIMI_API_KEY`
- [MiniMax](https://platform.minimax.io) → `MINIMAX_API_KEY`
- Generate a proxy secret: `openssl rand -hex 32` → `CURSORPROXY_API_KEY`

### 2. Set up KV storage
- **Vercel:** create a free [Upstash](https://upstash.com) database → `KV_URL` + `KV_TOKEN`
- **Docker:** add `REDIS_URL=redis://redis:6379` to your `.env`
- **EdgeOne Pages:** create a KV namespace in the console and bind it with variable name `cursorproxy_kv`

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

> **Log control:** `docker-compose.yml` caps container logs at 10 MiB × 3 rotated files per service. Set `DEBUG=true` in `.env` only for troubleshooting — it enables per-request access logs and verbose proxy internals. For `docker run`, add `--log-opt max-size=10m --log-opt max-file=3`.

### 4. Configure Cursor

| Field | Value |
|---|---|
| Base URL | `https://<your-host>/v1` |
| API Key | Your `CURSORPROXY_API_KEY` |
| Model | Discovered from `GET /v1/models` when `CURSORPROXY_MODELS` is set, or manually entered |

The proxy routes to the correct upstream based on the model name prefix (`deepseek*`, `kimi*`, `minimax*` / `MiniMax*`) and uses the corresponding server-side API key.

---

## Essential Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CURSORPROXY_API_KEY` | Recommended | Client auth secret |
| `CURSORPROXY_MODELS` | Optional | Comma- or newline-separated model IDs returned by `GET /v1/models` |
| `DEEPSEEK_API_KEY` | For DeepSeek | Upstream API key |
| `KIMI_API_KEY` | For Kimi | Upstream API key |
| `MINIMAX_API_KEY` | For MiniMax | Upstream API key (also used for vision) |
| `KV_URL` / `KV_TOKEN` | Vercel: yes | Upstash Redis REST credentials |
| `REDIS_URL` | Docker: recommended | Local Redis URL |
| `EDGEONE_KV_BINDING` | EdgeOne: no | KV namespace binding variable name (default `cursorproxy_kv`) |

Full reference: [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration).

---

## Wiki

- [Deployment](https://github.com/lqdflying/cursorProxy/wiki/Deployment) — Step-by-step: Vercel, Docker, Compose, 1Panel, Nginx
- [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration) — Every env var, routing logic, Cursor setup
- [Advanced Usage](https://github.com/lqdflying/cursorProxy/wiki/Advanced-Usage-for-CursorProxy) — OAI VSCode Plugin and other OpenAI-compatible clients
- [Architecture](https://github.com/lqdflying/cursorProxy/wiki/Architecture) — Request flow, TLS, file structure
- [Development](https://github.com/lqdflying/cursorProxy/wiki/Development) — Contributing, adding providers

---

## License

MIT
