# Vision Bridge

## Cursor ↔ cursorProxy Vision Collaboration

All five provider paths work with images except one: directly named GPT-5 / o-series
models on affected Cursor builds (for example `gpt-5.4` or `gpt-5.5`). The
`gpt-general` alias is vision-capable and works end-to-end because Cursor never
matches the alias name against the GPT-5.x pattern that triggers its BYOK
validation.

The proxy vision bridge only applies to DeepSeek and MiniMax (text-only
providers). All other providers — including `gpt-general` — receive images
natively.

```mermaid
flowchart TD
    U["User attaches image in Cursor"]
    M{"Which model?"}

    %% ── Path A: DeepSeek / MiniMax ──────────────────────────────────────────
    A_MODEL["deepseek-* / minimax-*\n(no native vision support)"]
    A_CURSOR["Cursor routes to custom base URL ✅\n(non-GPT name — no BYOK validation)"]
    A_GATE["cursorProxy:\nprovider in providersWithoutVision\n→ Vision Bridge runs"]
    A_KV["KV cache check (img:<sha256>)"]
    A_VIS["Vision API\n(MiniMax VL-01 or OpenAI-compatible)"]
    A_TEXT["image_url → '[Image content: ...]' text"]
    A_DS["DeepSeek / MiniMax API (text-only ✅)"]
    A_OK["Response → Cursor ✅"]

    %% ── Path B: Kimi ─────────────────────────────────────────────────────────
    B_MODEL["kimi-*\n(natively vision-capable)"]
    B_CURSOR["Cursor routes to custom base URL ✅\n(non-GPT name — no BYOK validation)"]
    B_GATE["cursorProxy: bridge skipped\nimages forwarded natively"]
    B_KIMI["Kimi API (native image_url ✅)"]
    B_OK["Response → Cursor ✅"]

    %% ── Path C: Azure Anthropic ──────────────────────────────────────────────
    C_MODEL["claude-*\n(natively vision-capable)"]
    C_CURSOR["Cursor uses Anthropic key path ✅\n(separate from OpenAI BYOK)"]
    C_GATE["cursorProxy: bridge skipped\nimages forwarded natively"]
    C_AA["Azure Anthropic API (native ✅)"]
    C_OK["Response → Cursor ✅"]

    %% ── Path D: gpt-general alias — WORKS ───────────────────────────────────
    D_MODEL["gpt-general (alias)\n(natively vision-capable)"]
    D_CURSOR["Cursor routes to custom base URL ✅\n'gpt-general' does not match gpt-5.x pattern\n→ no BYOK validation triggered"]
    D_GATE["cursorProxy: bridge skipped\nimages forwarded natively"]
    D_AO["Azure OpenAI — real deployment\n(e.g. gpt-5.5 backend, native vision ✅)"]
    D_OK["Response → Cursor ✅"]

    %% ── Path E: direct GPT-5 / o-series name — BROKEN ───────────────────────
    E_MODEL["Direct gpt-5.x / o-series name\n(natively vision-capable)"]
    E_VAL["Cursor matches gpt-5.x pattern\n→ triggers OpenAI BYOK validation:\nGET api.openai.com/v1/models ⚠\n(hardcoded — ignores custom base URL)"]
    E_FAIL["api.openai.com → 401 Unauthorized\n(CURSORPROXY_API_KEY is not a real OpenAI key)"]
    E_ABORT["Request aborted ❌\ncursorProxy never reached"]

    U --> M
    M -->|"deepseek / minimax"| A_MODEL --> A_CURSOR --> A_GATE --> A_KV
    A_KV -->|cache hit| A_TEXT
    A_KV -->|cache miss| A_VIS --> A_TEXT
    A_TEXT --> A_DS --> A_OK

    M -->|kimi| B_MODEL --> B_CURSOR --> B_GATE --> B_KIMI --> B_OK
    M -->|claude| C_MODEL --> C_CURSOR --> C_GATE --> C_AA --> C_OK
    M -->|gpt-general| D_MODEL --> D_CURSOR --> D_GATE --> D_AO --> D_OK
    M -->|"gpt-5.x directly"| E_MODEL --> E_VAL --> E_FAIL --> E_ABORT
```

| Model | Native vision? | Proxy vision bridge? | Cursor routing | End-to-end result |
|---|---|---|---|---|
| DeepSeek / MiniMax | ❌ No | ✅ Yes — image → text | Custom base URL (direct) | ✅ Works via bridge |
| Kimi | ✅ Yes | ❌ No | Custom base URL (direct) | ✅ Works natively |
| Azure Anthropic (Claude) | ✅ Yes | ❌ No | Anthropic key path | ✅ Works natively |
| `gpt-general` (alias) | ✅ Yes | ❌ No | Custom base URL — alias name skips BYOK validation | ✅ Works natively |
| Direct `gpt-5.x` / o-series name | ✅ Yes | ❌ No — proxy never reached | BYOK validation → `api.openai.com` → **401** | ❌ Broken — Cursor bug |

> The BYOK validation fires because Cursor matches the literal model name against a `gpt-5.x`
> pattern. Using the `gpt-general` alias avoids the match, so images work. The same pattern
> check also controls `apply_patch` tool inclusion — see `known-issues.md` for the trade-off
> between the two model configurations.

---

## Vision Bridge Detail (DeepSeek / MiniMax only)

Providers that only accept text (DeepSeek, MiniMax chat endpoint) cannot handle
`image_url` content parts. The vision bridge intercepts those messages, describes
every image via a vision-capable API, and replaces the image parts with text
before the request is forwarded.

## When the Bridge Activates

```mermaid
flowchart LR
    P{"Provider?"}
    DS["deepseek"]
    MM["minimax"]
    SKIP["Skip — provider\nsupports vision natively\n(Azure OpenAI, Azure Anthropic, Kimi)"]
    VB["Vision Bridge runs"]

    P -->|deepseek| DS --> VB
    P -->|minimax| MM --> VB
    P -->|other| SKIP
```

## Full Vision Bridge Flow

```mermaid
sequenceDiagram
    participant P as cursorProxy
    participant KV as KV Store<br/>(Redis / Upstash)
    participant VIS as Vision API<br/>(MiniMax VL-01 or GPT-4o-mini)

    Note over P: Scan all messages for image_url parts<br/>Collect unique images

    loop For each unique image (bounded concurrency, default 2)
        P->>P: SHA-256 hash of image data URI

        P->>KV: GET img:<sha256>
        alt Cache hit
            KV-->>P: Cached text description
        else Cache miss
            P->>VIS: Describe image<br/>(timeout: VISION_TIMEOUT_MS, default 15 000 ms)

            alt Vision API responds in time
                VIS-->>P: Text description
                P->>KV: SET img:<sha256> = description (TTL 2h)
            else Timeout or error
                Note over P: Insert placeholder text:<br/>"[Image could not be processed]"
            end
        end

        Note over P: Replace image_url part with text description
    end

    alt All images failed AND non-streaming request
        P-->>Client: 502 vision_unavailable error<br/>(don't forward degraded request)
    else Streaming OR at least one image succeeded
        Note over P: Forward modified messages upstream
    end
```

## Vercel Pre-stream Budget Guard

```mermaid
flowchart TD
    START["Vision bridge completes"]
    VERCEL{"Running on\nVercel Edge?"}
    ELAPSED["Measure elapsed time\nsince request start"]
    CHECK{"elapsed > PRESTREAM_BUDGET_MS\n(default 22 000 ms)?"}
    FAIL["Return 504 prestream_timeout\nto Cursor\n(Vercel would kill the request\nbefore first byte anyway)"]
    OK["Proceed to upstream call"]

    START --> VERCEL
    VERCEL -->|no - Docker / EdgeOne| OK
    VERCEL -->|yes| ELAPSED --> CHECK
    CHECK -->|exceeded| FAIL
    CHECK -->|within budget| OK
```

## Concurrency & Timeout Model

```mermaid
flowchart LR
    subgraph "Request with 4 images"
        I1["Image 1"]
        I2["Image 2"]
        I3["Image 3"]
        I4["Image 4"]
    end

    subgraph "Concurrency = 2 (default)"
        subgraph "Batch 1 (parallel)"
            V1["Vision call → desc1"]
            V2["Vision call → desc2"]
        end
        subgraph "Batch 2 (parallel)"
            V3["Vision call → desc3"]
            V4["Timeout → placeholder"]
        end
    end

    I1 --> V1
    I2 --> V2
    V1 --> B2["Batch 2 starts\nafter Batch 1 done"]
    V2 --> B2
    B2 --> V3
    B2 --> V4
```

## Vision API Selection

```mermaid
flowchart LR
    ENV{"VISION_API_PROVIDER\nenv var set?"}
    MM_VIS["MiniMax VL-01\n(default)\nPOST /v1/coding_plan/vlm\nuses MINIMAX_API_KEY"]
    OAI_VIS["OpenAI-compatible\n(default model: gpt-4o-mini)\nPOST /v1/chat/completions\nuses VISION_API_KEY"]

    ENV -->|not set or 'minimax_vl'| MM_VIS
    ENV -->|'openai'| OAI_VIS
```

## Cache Key Structure

```
img:<sha256-of-image-data-uri>
│
├── Value: plain text description
└── TTL:   KV_TTL_SECONDS (default 7200 s / 2 h)
```

The same image sent in different conversations or by different users hits the
same cache key — image content is provider-agnostic and user-agnostic.

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `VISION_API_PROVIDER` | `minimax_vl` | Backend: `minimax_vl` or `openai` |
| `VISION_API_URL` | (provider default) | Override vision endpoint URL |
| `VISION_MODEL` | `MiniMax-VL-01` / `gpt-4o-mini` | Override vision model name |
| `VISION_TIMEOUT_MS` | 15 000 | Per-image call timeout (0 = disabled) |
| `VISION_CONCURRENCY` | 2 | Max parallel vision calls |
| `PRESTREAM_BUDGET_MS` | 22 000 | Vercel pre-stream wall time |
| `MINIMAX_API_KEY` | — | Used when `VISION_API_PROVIDER=minimax_vl` |
| `VISION_API_KEY` | — | Used when `VISION_API_PROVIDER=openai` |
