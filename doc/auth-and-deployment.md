# Authentication, Cache Scoping & Deployment Modes

## Authentication Flow

```mermaid
flowchart TD
    REQ["Incoming request"]
    ENV{"CURSORPROXY_API_KEY\nenv var set?"}
    ANON["Anonymous mode\nAll clients share\none cache scope\n(warn logged once)"]
    EXTRACT["Extract client key\nfrom Authorization: Bearer\nor x-api-key header"]
    COMPARE{"Timing-safe\nconstant-time compare\ncrypto.subtle.digest()"}
    PASS["Request allowed\nCache scoped to\nclient key hash"]
    FAIL["401 Unauthorized"]

    REQ --> ENV
    ENV -->|not set| ANON
    ENV -->|set| EXTRACT --> COMPARE
    COMPARE -->|match| PASS
    COMPARE -->|mismatch| FAIL
```

> Timing-safe comparison prevents timing-oracle attacks where an attacker
> measures response time differences to guess the key character-by-character.

## Cache Scope Isolation Per User

```mermaid
flowchart LR
    subgraph "With CURSORPROXY_API_KEY set"
        U1["User A\nBearer key-A"]
        U2["User B\nBearer key-B"]
        SC1["Cache scope:\nprovider:sha256(key-A)"]
        SC2["Cache scope:\nprovider:sha256(key-B)"]
        KV1["KV keys prefixed\nwith scope-A"]
        KV2["KV keys prefixed\nwith scope-B"]
        U1 --> SC1 --> KV1
        U2 --> SC2 --> KV2
    end

    subgraph "Without CURSORPROXY_API_KEY"
        UA["All users"]
        SC0["Cache scope:\nprovider:(empty)"]
        KV0["Shared KV keys\n(reasoning/thinking\ncross-contamination risk)"]
        UA --> SC0 --> KV0
    end
```

## Deployment Modes Comparison

```mermaid
flowchart TD
    subgraph "Docker (self-hosted)"
        D_ENTRY["server.js\nNode.js 20 HTTP server\nport 3000 (configurable)"]
        D_KV["Redis 7\nLocal container\nRDB snapshots"]
        D_TIMEOUT["Stream timeout: disabled (0)\nConnect timeout: 15 s"]
        D_ENTRY <-->|ioredis| D_KV
    end

    subgraph "Vercel Edge"
        V_ENTRY["api/proxy.js\nEdge Runtime (V8 isolate)\nvercel.json rewrites /v0/* and /v1/*"]
        V_KV["Upstash Redis\nREST API over HTTPS\nKV_URL + KV_TOKEN"]
        V_TIMEOUT["Stream timeout: 280 s\n(under 300 s platform limit)\nPre-stream budget: 22 s"]
        V_ENTRY <-->|fetch Bearer| V_KV
    end

    subgraph "EdgeOne Pages"
        E_ENTRY["edge-functions/v1/[[default]].js\nEdgeOne Edge Function\nEdge Runtime"]
        E_KV["EdgeOne KV\nEdge Function binding\nEDGEONE_KV_BINDING"]
        E_ENTRY <-->|binding| E_KV
    end
```

## Deployment Mode Feature Matrix

| Feature | Docker | Vercel Edge | EdgeOne Pages |
|---|---|---|---|
| Entry point | `server.js` | `api/proxy.js` via `vercel.json` rewrites | `edge-functions/v1/[[default]].js` |
| KV backend | Local Redis (ioredis) | Upstash REST | EdgeOne KV binding |
| Stream timeout | Disabled | 280 s | Disabled by default |
| Pre-stream budget guard | No | Yes (22 s default) | No |
| Graceful shutdown | Yes (25 s drain) | N/A (stateless) | N/A (stateless) |
| Access logging | Yes (DEBUG=true) | Yes (DEBUG=true) | Yes (DEBUG=true, Edge Function logs) |
| Health check | `GET /health` | N/A | `GET /health` |

## EdgeOne KV Runtime

EdgeOne Pages KV is exposed to Edge Functions, so the proxy routes `/v0/*`,
`/v1/*`, and legacy provider paths through `edge-functions/`. The default KV
binding variable name is `cursorproxy_kv`; set `EDGEONE_KV_BINDING` only if you
bind the namespace under a different variable name.

Do not add same-path Cloud Function entry files for these API routes unless you
also switch to another KV backend such as Upstash. Cloud Functions do not receive
the built-in EdgeOne Pages KV binding, so reasoning, response-id, Claude thinking,
and image caches would no-op. Use `DEBUG=true` only while troubleshooting because
it logs request routing and proxy internals.

## Docker Graceful Shutdown

```mermaid
sequenceDiagram
    participant OS as OS / Orchestrator
    participant S as server.js
    participant REQ as In-flight requests

    OS->>S: SIGTERM or SIGINT
    Note over S: server.close() — stop accepting\nnew connections
    Note over S: Wait up to SHUTDOWN_GRACE_MS\n(default 25 000 ms) for\nin-flight requests to finish
    REQ-->>S: requests complete (or timeout)
    S->>OS: process.exit(0)
```

## URL Routing (Vercel Rewrites)

```mermaid
flowchart LR
    subgraph "Incoming paths"
        P0["/v0/:path*"]
        P1["/v1/:path*"]
        P2["/deepseek/v1/:path*"]
        P3["/kimi/v1/:path*"]
        P4["/minimax/v1/:path*"]
        P5["/azure-openai/v1/:path*"]
        P6["/azure-anthropic/v1/:path*"]
    end

    subgraph "Rewrites to"
        H["/api/proxy"]
    end

    P0 -->|"?path=:path*\n(legacy unified route)"| H
    P1 -->|"?path=:path*\n(model-based routing)"| H
    P2 -->|"?provider=deepseek&path=:path*"| H
    P3 -->|"?provider=kimi&path=:path*"| H
    P4 -->|"?provider=minimax&path=:path*"| H
    P5 -->|"?provider=azureopenai&path=:path*"| H
    P6 -->|"?provider=azureanthropic&path=:path*"| H
```

## Environment Variables Reference

### Common

| Variable | Purpose |
|---|---|
| `CURSORPROXY_API_KEY` | Proxy auth key (unset = anonymous) |
| `CURSORPROXY_MODELS` | Comma/newline-separated list of model IDs for `/v1/models` |
| `DEBUG` | `true` to enable per-request debug logs |
| `KV_TTL_SECONDS` | Cache TTL for all key types (default 7 200 s) |

### KV Backends

| Variable | Backend |
|---|---|
| `REDIS_URL` | Docker local Redis |
| `KV_URL` + `KV_TOKEN` | Upstash (Vercel) |
| `EDGEONE_KV_BINDING` | EdgeOne Pages KV |

### Timeouts

| Variable | Default | Notes |
|---|---|---|
| `UPSTREAM_CONNECT_TIMEOUT_MS` | 15 000 | Connect-phase only; set 0 to disable |
| `STREAM_TIMEOUT_SECONDS` | 280 (Vercel) / 0 (EdgeOne Edge Functions and Docker default) | 0 = disabled |
| `PRESTREAM_BUDGET_MS` | 22 000 | Vercel only |
| `SHUTDOWN_GRACE_MS` | 25 000 | Docker only |
