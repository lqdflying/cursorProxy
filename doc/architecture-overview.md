# Overall System Architecture

## Top-level Overview

```mermaid
flowchart TD
    subgraph "Cursor IDE"
        CUR["Cursor\nOpenAI-compatible client\n(Chat Completions format)"]
    end

    subgraph "cursorProxy"
        EP["Entry point\n(server.js / edge function)"]
        AUTH["Auth check\nCURSORPROXY_API_KEY"]
        ROUTE["Provider routing\n(model name → provider)"]
        ALIAS["Alias resolution\ngpt-general → real deployment"]
        TOOLS["Tool normalization\n(apply_patch, function, custom)"]
        FMT["Format conversion\n(Chat Completions ↔ provider API)"]
        VB["Vision bridge\n(image → text for DeepSeek/MiniMax)"]
        RSN["Reasoning injection\n(prior turns)"]
    end

    subgraph "KV Store (shared)"
        KV["conv: reasoning\nazresp: response IDs\nimg: vision descriptions\nclaude_thinking: thinking blocks"]
    end

    subgraph "AI Providers"
        DS["DeepSeek\napi.deepseek.com"]
        KI["Kimi\napi.moonshot.ai"]
        MM["MiniMax\napi.minimax.io"]
        AO["Azure OpenAI\nResponses API"]
        AA["Azure Anthropic\nMessages API"]
    end

    CUR -->|"POST /v1/chat/completions\nBearer <CURSORPROXY_API_KEY>"| EP
    EP --> AUTH --> ROUTE --> ALIAS
    ALIAS --> TOOLS --> FMT
    FMT --> VB --> RSN
    RSN <-->|read/write| KV
    FMT <-->|read/write| KV

    RSN -->|deepseek-*| DS
    RSN -->|kimi-*| KI
    RSN -->|minimax-*| MM
    ALIAS -->|gpt-* / o-series| AO
    ALIAS -->|claude-*| AA

    DS -->|reasoning_content| FMT
    KI -->|reasoning_content| FMT
    MM -->|reasoning_details| FMT
    AO -->|Responses API SSE| FMT
    AA -->|Messages API SSE| FMT

    FMT -->|"OpenAI Chat Completions format\n(streaming SSE or JSON)"| CUR
```

## Deployment Topologies

```mermaid
flowchart LR
    subgraph "Docker / Docker Compose"
        SC["server.js\nNode.js HTTP server\nport 3000"]
        RD["Redis 7\n(docker-compose service)"]
        SC <-->|ioredis REDIS_URL| RD
    end

    subgraph "Vercel Edge"
        VEF["edge-functions/v1/[[default]].js\nVercel Edge Runtime"]
        UP_KV["Upstash Redis\n(REST API over HTTPS)\nKV_URL + KV_TOKEN"]
        VEF <-->|fetch + Bearer| UP_KV
    end

    subgraph "EdgeOne Pages"
        EOF["edge-functions/v1/[[default]].js\nEdgeOne Edge Runtime"]
        EO_KV["EdgeOne KV\n(global namespace binding)\nEDGEONE_KV_BINDING"]
        EOF <-->|binding| EO_KV
    end

    Cursor -->|custom API URL| SC
    Cursor -->|custom API URL| VEF
    Cursor -->|custom API URL| EOF
```

## Request Lifecycle

```mermaid
flowchart TD
    REQ["Incoming request"]

    A{"Health check?\nGET /health"}
    B{"Model discovery?\nGET /v1/models"}
    C{"Unsafe path?"}
    D{"POST body\nparse OK?"}
    E{"Provider\nresolved?"}
    F{"API key\nconfigured?"}

    VISION["Vision bridge\n(DeepSeek / MiniMax only)"]
    INJECT["Reasoning injection\n(all providers)"]
    THINK["Claude thinking injection\n(azureanthropic only)"]
    UPSTREAM["Forward to upstream\n(with connect timeout)"]
    STREAM{"Streaming?"}
    NONSTR["Buffer response\nconvert format\ncache reasoning/ID/thinking\nreturn JSON"]
    STR["Pipe SSE stream\nconvert events in real-time\ncache mid-stream snapshots\nemit OpenAI-format chunks"]

    REQ --> A
    A -->|yes| HEALTH["200 OK"]
    A -->|no| B
    B -->|yes| MODELS["model list JSON"]
    B -->|no| C
    C -->|yes| ERR400["400 invalid_path"]
    C -->|no| D
    D -->|fail| ERR400
    D -->|ok| E
    E -->|unknown| ERR400
    E -->|known| F
    F -->|missing| ERR503["503 provider_key_missing"]
    F -->|ok| VISION --> INJECT --> THINK --> UPSTREAM
    UPSTREAM -->|error| ERR504["504 upstream_timeout"]
    UPSTREAM -->|ok| STREAM
    STREAM -->|no| NONSTR
    STREAM -->|yes| STR
```

## Model Name → Provider Mapping

```mermaid
flowchart LR
    M["Model name\n(bare, after stripping cursorproxy/)"]

    M -->|"claude-*"| AA2["azureanthropic"]
    M -->|"gpt-general (alias)"| AO2["azureopenai"]
    M -->|"gpt-* or o\\d*"| AO2
    M -->|"minimax-*"| MM2["minimax"]
    M -->|"kimi-*"| KI2["kimi"]
    M -->|"deepseek-*"| DS2["deepseek"]
    M -->|"(anything else)"| DS2
```

## Component Map

| File | Role |
|---|---|
| `server.js` | HTTP server entry point (Docker) |
| `edge-functions/v1/[[default]].js` | Edge entry point (Vercel / EdgeOne) |
| `api/proxy.js` | Core handler: routing, conversion, streaming |
| `api/models.js` | Model ID parsing, alias resolution, `/v1/models` |
| `api/auth.js` | Proxy auth, timing-safe key comparison |
| `api/azure-openai.js` | Azure Responses API ↔ OpenAI Chat Completions |
| `api/azure-anthropic.js` | Azure Anthropic Messages API ↔ OpenAI Chat Completions |
| `api/reasoning.js` | Reasoning block caching and injection |
| `api/vision-bridge.js` | Batch image-to-text conversion |
| `api/vision.js` | Vision API calls (MiniMax VL-01 / GPT-4o-mini) |
| `api/cache.js` | Conversation and image hashing |
| `api/kv.js` | KV abstraction (Redis / Upstash / EdgeOne) |
| `api/logger.js` | Debug logging utility |

## Key Environment Variables (All Providers)

| Variable | Purpose |
|---|---|
| `CURSORPROXY_API_KEY` | Proxy auth gate (unset = anonymous, shared cache scope) |
| `CURSORPROXY_MODELS` | Comma/newline list of model IDs exposed at `GET /v1/models` |
| `DEBUG` | `true` enables per-request verbose logs |
| **DeepSeek** | |
| `DEEPSEEK_API_KEY` | DeepSeek auth |
| `DEEPSEEK_REASONING_EFFORT` | `high` (default) or `max` |
| **Kimi** | |
| `KIMI_API_KEY` | Kimi / Moonshot auth |
| **MiniMax** | |
| `MINIMAX_API_KEY` | MiniMax auth (also used for default vision backend) |
| **Azure (shared)** | |
| `AZURE_FOUNDRY_API_KEY` | Shared key for Azure OpenAI and Azure Anthropic |
| `AZURE_FOUNDRY_RESOURCE` | Azure resource name (used to build default endpoint URLs) |
| **Azure OpenAI** | |
| `AZURE_OPENAI_ENDPOINT` | Full endpoint URL override |
| `AZURE_OPENAI_API_VERSION` | API version (default `2025-04-01-preview`) |
| `AZURE_OPENAI_GENERAL_ALIAS_TARGET` | Real deployment behind `gpt-general` alias |
| `AZURE_OPENAI_GENERAL_REASONING_EFFORT` | Reasoning effort override for `gpt-general` |
| `AZURE_OPENAI_REASONING_EFFORT` | Global reasoning effort for all Azure reasoning models |
| **Azure Anthropic** | |
| `AZURE_ANTHROPIC_ENDPOINT` | Full endpoint URL override |
| **Vision** | |
| `VISION_API_PROVIDER` | `minimax_vl` (default) or `openai` |
| `VISION_API_KEY` | API key when `VISION_API_PROVIDER=openai` |
| `VISION_API_URL` | Override vision endpoint URL |
| `VISION_MODEL` | Override vision model name |
| `VISION_TIMEOUT_MS` | Per-image timeout ms (default 15 000, 0 = disabled) |
| `VISION_CONCURRENCY` | Max parallel vision calls (default 2) |
| **KV / Caching** | |
| `KV_TTL_SECONDS` | Cache TTL seconds (default 7 200 / 2 h) |
| `KV_RETRY_DELAYS_MS` | Reasoning retry delays ms, comma-separated (default `40,120,240,400`) |
| `REDIS_URL` | Local Redis (Docker) |
| `KV_URL` + `KV_TOKEN` | Upstash Redis (Vercel) |
| `EDGEONE_KV_BINDING` | EdgeOne KV namespace binding |
| **Timeouts** | |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | Connect-phase timeout ms (default 15 000, 0 = disabled) |
| `STREAM_TIMEOUT_SECONDS` | Stream timeout (default 280 on Vercel, 0 = disabled on Docker) |
| `PRESTREAM_BUDGET_MS` | Vercel pre-stream wall time ms (default 22 000) |
| `SHUTDOWN_GRACE_MS` | Docker graceful drain ms (default 25 000) |
