# KV Store & Caching Architecture

The proxy uses a single KV abstraction (`lib/kv.js`) that supports three
backends. All caching is stateless per-request — no shared in-process memory.

## Backend Selection

```mermaid
flowchart TD
    START["kvGet / kvSet called"]
    RD["ioredis\n(local Redis)"]
    E1{"REDIS_URL\nset?"}
    UP["Upstash REST\n(Bearer auth over HTTPS)"]
    E2{"KV_URL + KV_TOKEN\nset?"}
    EO["EdgeOne KV\n(Cloud Function namespace binding)"]
    E3{"EDGEONE_KV_BINDING\nor registered binding available?"}
    NOP["No-op\n(KV disabled, caching skipped)"]

    START --> E1
    E1 -->|yes| RD
    E1 -->|no| E2
    E2 -->|yes| UP
    E2 -->|no| E3
    E3 -->|yes| EO
    E3 -->|no| NOP
```

## Cache Key Types

```mermaid
flowchart LR
    subgraph "conv: — Reasoning chains"
        CK["conv:\n<sha256(provider:user:messages)>"]
        CV["Value: serialized reasoning\n(reasoning_content string\nor reasoning_details JSON)"]
    end

    subgraph "azresp: — Azure response IDs"
        AK["azresp:conv:\n<sha256(azureopenai:v7:resource:deployment:user:messages)>"]
        AV["Value: response ID string\n(e.g. resp_abc123)"]
    end

    subgraph "oairesp: — OpenAI-compatible response IDs"
        OK["oairesp:conv:\n<sha256(openaicompat:v1:upstream:model:user:messages)>"]
        OK2["sub2api mode:\n<sha256(openaicompat:v1:sub2api:upstream:model:session:user:messages)>"]
        OV["Value: response ID string\n(e.g. resp_abc123)"]
    end

    subgraph "img: — Vision descriptions"
        IK["img:\n<sha256(image-data-uri)>"]
        IV["Value: plain text description"]
    end

    subgraph "claude_thinking: — Claude thinking blocks"
        TK["claude_thinking:asst:\n<sha256(azureanthropic:user:messages-normalized)>"]
        TV["Value: JSON array of\ncontent_block objects\n[{type:thinking, thinking:..., signature:...}]"]
    end
```

## Who Reads and Writes Each Key

```mermaid
flowchart TD
    subgraph Providers["Provider families"]
        DS["DeepSeek / Kimi / MiniMax"]
        AO["Azure OpenAI"]
        OC["OpenAI-compatible\nResponses mode"]
        AA["Azure Anthropic"]
    end

    subgraph Keys["KV keys"]
        CONV["conv:*\n(reasoning)"]
        AZRESP["azresp:*\n(Azure response IDs)"]
        OIRESP["oairesp:*\n(OpenAI-compatible response IDs)"]
        IMG["img:*\n(vision)"]
        THINK["claude_thinking:*\n(thinking blocks)"]
    end

    DS -->|write mid-stream + at DONE| CONV
    DS -->|read at request start| CONV

    AO -->|write at DONE / response.completed| AZRESP
    AO -->|read at request start with retries| AZRESP

    OC -->|write at DONE / response.completed| OIRESP
    OC -->|read at request start with retries| OIRESP

    DS -->|write on cache miss| IMG
    DS -->|read before vision call| IMG

    AA -->|write at DONE / message_stop| THINK
    AA -->|read at request start| THINK
```

## Reasoning Snapshot Strategy (conv:)

```mermaid
sequenceDiagram
    participant UP as Upstream stream
    participant P as Proxy
    participant KV as KV Store

    loop Each chunk with reasoning content
        UP-->>P: chunk with reasoning_content delta
        P->>P: accReasoning += delta

        alt size grew by ≥ 256 chars (DeepSeek/Kimi)<br/>or ≥ 1 char (MiniMax)
            P-->>KV: SET conv:<hash> (fire-and-forget)<br/>does NOT block stream
        end
    end

    UP-->>P: [DONE]
    P->>KV: SET conv:<hash> (await — guaranteed write)
```

> Mid-stream snapshots ensure that if the stream is interrupted, the next turn
> still recovers partial reasoning rather than starting from scratch.

## Retry Logic

### Response IDs (azresp: / oairesp:) — hardcoded delays

```mermaid
sequenceDiagram
    participant C as Cursor (Turn N+1)
    participant P as Proxy
    participant KV as KV Store

    C->>P: new request (conversation continues)
    Note over P: Compute hash of messages before\nlast assistant block

    P->>KV: GET azresp:conv:<prev_hash>\nor oairesp:conv:<prev_hash> (attempt 1, 0 ms delay)
    alt hit
        KV-->>P: response ID
    else miss
        P->>KV: GET response-id key (attempt 2, 80 ms delay)
        alt hit
            KV-->>P: response ID
        else miss
            P->>KV: GET response-id key (attempt 3, 200 ms delay)
            alt hit
                KV-->>P: response ID
            else miss — stateless fallback
                Note over P: Send full input array\n(no previous_response_id)
            end
        end
    end
```

> Retries cover the race where Cursor fires a follow-up turn while the prior
> turn's `finally` block is still flushing the response ID to KV.
> Delays are hardcoded: `[0, 80, 200]` ms (total max wait ~280 ms).

For OpenAI-compatible Responses mode, `OPENAICOMPAT_CACHE_HIT_MODE=sub2api`
adds sub2api-style cache hints while keeping cursorProxy's exact-prefix KV
response-ID lookup:

- injects `prompt_cache_key=compat_cc_<hash>` for GPT-5/Codex-like models when
  the client did not send one;
- scopes `oairesp:` keys by `session_id`, then `conversation_id`, then
  `prompt_cache_key`, then a content-derived `compat_cs_<hash>` seed;
- deletes stale previous-response KV entries on `previous_response_not_found`
  and retries stateless so the successful retry can refresh the chain;
- suppresses unsupported `previous_response_id` scopes for `KV_TTL_SECONDS`.

### Reasoning (conv:) — configurable delays

```mermaid
sequenceDiagram
    participant P as Proxy
    participant KV as KV Store

    P->>KV: GET conv:<hash> (attempt 1, immediate)
    alt hit
        KV-->>P: reasoning value
    else miss
        P->>KV: GET conv:<hash> (attempt 2, +40 ms)
        alt hit
            KV-->>P: reasoning value
        else miss
            P->>KV: GET conv:<hash> (attempt 3, +120 ms)
            alt hit
                KV-->>P: reasoning value
            else miss
                P->>KV: GET conv:<hash> (attempt 4, +240 ms)
                alt hit
                    KV-->>P: reasoning value
                else miss
                    P->>KV: GET conv:<hash> (attempt 5, +400 ms)
                    alt hit
                        KV-->>P: reasoning value
                    else miss — inject placeholder
                        Note over P: reasoning_content = "(prior reasoning unavailable)"
                    end
                end
            end
        end
    end
```

> Configurable via `KV_RETRY_DELAYS_MS` (comma-separated ms, default `40,120,240,400`).
> Total max wait ~800 ms across 4 retries.

## Cache Scope Isolation

```mermaid
flowchart TD
    subgraph "conv: scope"
        CS["provider : user"]
    end

    subgraph "azresp: scope"
        AS["azresp:conv:\nazureopenai : v7 : azure-resource : deployment : user"]
    end

    subgraph "oairesp: scope"
        OS["oairesp:conv:\nopenaicompat : v1 : upstream-base : model : user"]
        OS2["sub2api mode:\nopenaicompat : v1 : sub2api : upstream-base : model : session-anchor : user"]
    end

    subgraph "claude_thinking: scope"
        TS["claude_thinking:asst:\nazureanthropic : user\n(normalized hash — ignores content format changes)"]
    end

    subgraph "img: scope"
        IS["(none — global across all users and providers)"]
    end

    note1["Azure scope includes deployment name:\nchanging AZURE_OPENAI_GENERAL_ALIAS_TARGET\nyields a fresh bucket — prevents 400 errors\nfrom replaying IDs across deployments"]

    note2["OpenAI-compatible scope includes upstream base and model:\nchanging UPSTREAM_OPENAICOMPAT, path tenant, or model\nyields a fresh bucket — prevents replaying IDs\nagainst the wrong gateway/model.\nsub2api mode also includes a session anchor."]

    AS --- note1
    OS --- note2
```

## TTL & Eviction

| Key type | Default TTL | Controlled by |
|---|---|---|
| `conv:*` | 7 200 s (2 h) | `KV_TTL_SECONDS` |
| `azresp:*` | 7 200 s (2 h) | `KV_TTL_SECONDS` |
| `oairesp:*` | 7 200 s (2 h) | `KV_TTL_SECONDS` |
| `claude_thinking:*` | 7 200 s (2 h) | `KV_TTL_SECONDS` |
| `img:*` | 604 800 s (7 d) | `KV_IMAGE_TTL_SECONDS` |

Conversation-scoped entries share `KV_TTL_SECONDS`. The image-description
cache uses its own longer TTL (`KV_IMAGE_TTL_SECONDS`, default 7 days) because
keys are content-addressed by SHA-256 of the data URI and the description is
effectively immutable — there's no reason to re-pay the vision-API cost every
2 hours. The cache version tags (`v7` in `azresp:`, `v1` in `oairesp:`) act as
logical namespace bumps — old keys are orphaned and expire naturally when the
cache version is incremented after a breaking schema change.

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `KV_TTL_SECONDS` | 7 200 | TTL for conversation-scoped keys (`conv:`, `azresp:`, `oairesp:`, `claude_thinking:`) |
| `OPENAICOMPAT_CACHE_HIT_MODE` | `default` | `sub2api` enables OpenAI-compatible Responses prompt cache key injection, session anchors, stale previous-response cleanup, and unsupported-scope TTLs |
| `KV_IMAGE_TTL_SECONDS` | 604 800 (7 d) | TTL for `img:*` description cache |
| `KV_FETCH_TIMEOUT_MS` | inherits `UPSTREAM_CONNECT_TIMEOUT_MS`, then 8 000 | Upstash REST request timeout; covers connect AND body read |
| `KV_RETRY_DELAYS_MS` | `40,120,240,400` | Reasoning KV read retry delays (ms, comma-separated) |
| `REDIS_URL` | — | Local Redis connection string (Docker) |
| `KV_URL` | — | Upstash Redis REST endpoint (Vercel) |
| `KV_TOKEN` | — | Upstash Redis Bearer token (Vercel) |
| `EDGEONE_KV_BINDING` | — | EdgeOne KV namespace binding name |
