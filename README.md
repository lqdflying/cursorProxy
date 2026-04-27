# cursorProxy — Multi-Provider Reasoning & Vision Proxy

A lightweight proxy for **DeepSeek**, **Kimi**, and **MiniMax** APIs. Deploy on Vercel Edge or self-host via Docker.

- **Reasoning bridge:** caches and injects `reasoning_content` by conversation position, enabling multi-turn reasoning in Cursor and OpenAI-compatible clients.
- **Vision bridge:** automatically converts inline images to text descriptions for models that don't support vision natively.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/lqdflying/cursorProxy)

---

## Quick Start

### 1. Get API keys
- [DeepSeek](https://platform.deepseek.com) → `DEEPSEEK_API_KEY`
- [Kimi](https://platform.moonshot.ai) → `KIMI_API_KEY`
- [MiniMax](https://platform.minimax.io) → `MINIMAX_API_KEY`
- Generate a proxy secret: `openssl rand -hex 32` → `CURSORPROXY_API_KEY`

### 2. Set up Redis
- **Vercel:** create a free [Upstash](https://upstash.com) database → `KV_URL` + `KV_TOKEN`
- **Docker:** add `REDIS_URL=redis://redis:6379` to your `.env`

### 3. Deploy

```bash
# Docker one-liner
docker run -d --pull always -p 127.0.0.1:3000:3000 --env-file .env lqdflying/cursorproxy:latest
```

For Vercel, Docker Compose, 1Panel, and Nginx reverse proxy — see [Deployment](https://github.com/lqdflying/cursorProxy/wiki/Deployment).

### 4. Configure Cursor

| Field | Value |
|---|---|
| Base URL | `https://<your-host>/v1` |
| API Key | Your `CURSORPROXY_API_KEY` |
| Model | e.g. `deepseek-v4-pro`, `kimi-k2.6`, `MiniMax-M2.7` |

The proxy routes to the correct upstream based on the model name prefix (`deepseek*`, `kimi*`, `minimax*` / `MiniMax*`) and uses the corresponding server-side API key.

---

## Essential Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CURSORPROXY_API_KEY` | Recommended | Client auth secret |
| `DEEPSEEK_API_KEY` | For DeepSeek | Upstream API key |
| `KIMI_API_KEY` | For Kimi | Upstream API key |
| `MINIMAX_API_KEY` | For MiniMax | Upstream API key (also used for vision) |
| `KV_URL` / `KV_TOKEN` | Vercel: yes | Upstash Redis REST credentials |
| `REDIS_URL` | Docker: recommended | Local Redis URL |

Full reference: [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration).

---

## Wiki

- [Deployment](https://github.com/lqdflying/cursorProxy/wiki/Deployment) — Step-by-step: Vercel, Docker, Compose, 1Panel, Nginx
- [Configuration](https://github.com/lqdflying/cursorProxy/wiki/Configuration) — Every env var, routing logic, Cursor setup
- [Architecture](https://github.com/lqdflying/cursorProxy/wiki/Architecture) — Request flow, TLS, file structure
- [Development](https://github.com/lqdflying/cursorProxy/wiki/Development) — Contributing, adding providers

---

## License

MIT
