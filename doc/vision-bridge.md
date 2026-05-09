# Vision Bridge

## Cursor ↔ cursorProxy Vision Collaboration

Three of the four provider families work with images. The proxy applies its
vision bridge only for DeepSeek and MiniMax (text-only providers). Kimi, Claude,
and Azure OpenAI are all natively vision-capable — the proxy passes images
straight through for all three. The Azure OpenAI path is broken not by the
proxy but by a Cursor-side BYOK routing bug that aborts the request before it
arrives.

```mermaid
flowchart TD
    U["User attaches image in Cursor"]
    M{"Which model family?"}

    %% ── Path A: DeepSeek / MiniMax ──────────────────────────────────────────
    A_MODEL["deepseek-* / minimax-*\n(no native vision support)"]
    A_CURSOR["Cursor routes directly to custom base URL ✅\n(non-GPT brand — no OpenAI validation)"]
    A_GATE["cursorProxy:\nprovider in providersWithoutVision\n→ Vision Bridge runs"]
    A_VIS["Vision API\n(MiniMax VL-01 or OpenAI-compatible)"]
    A_KV["KV cache check\n(img:<sha256>)"]
    A_TEXT["image_url parts replaced with\n'[Image content: ...]' text"]
    A_DS["DeepSeek / MiniMax API\n(text-only request ✅)"]
    A_OK["Response → Cursor ✅"]

    %% ── Path B: Kimi ─────────────────────────────────────────────────────────
    B_MODEL["kimi-*\n(natively vision-capable)"]
    B_CURSOR["Cursor routes directly to custom base URL ✅\n(non-GPT brand — no OpenAI validation)"]
    B_GATE["cursorProxy:\nnot in providersWithoutVision\n→ bridge skipped, images forwarded as-is"]
    B_KIMI["Kimi API\n(native image_url ✅)"]
    B_OK["Response → Cursor ✅"]

    %% ── Path C: Azure Anthropic ──────────────────────────────────────────────
    C_MODEL["claude-*\n(natively vision-capable)"]
    C_CURSOR["Cursor uses Anthropic key path ✅\n(not the OpenAI BYOK path — unaffected)"]
    C_GATE["cursorProxy:\nnot in providersWithoutVision\n→ bridge skipped, images forwarded as-is"]
    C_AA["Azure Anthropic API\n(native image format ✅)"]
    C_OK["Response → Cursor ✅"]

    %% ── Path D: Azure OpenAI — blocked by Cursor BYOK bug ────────────────────
    D_MODEL["gpt-general / gpt-5.x\n(natively vision-capable — no bridge needed)"]
    D_NOTE["cursorProxy would forward images natively\n(not in providersWithoutVision)\nbut proxy is never reached ↓"]
    D_VAL["Cursor triggers OpenAI BYOK validation first:\nGET api.openai.com/v1/models ⚠\n(hardcoded — ignores custom base URL)"]
    D_FAIL["api.openai.com → 401 Unauthorized\n(CURSORPROXY_API_KEY is not a real OpenAI key)"]
    D_ABORT["Request aborted ❌\ncursorProxy never reached"]

    U --> M
    M -->|"deepseek / minimax"| A_MODEL --> A_CURSOR --> A_GATE --> A_KV
    A_KV -->|cache hit| A_TEXT
    A_KV -->|cache miss| A_VIS --> A_TEXT
    A_TEXT --> A_DS --> A_OK

    M -->|kimi| B_MODEL --> B_CURSOR --> B_GATE --> B_KIMI --> B_OK

    M -->|claude| C_MODEL --> C_CURSOR --> C_GATE --> C_AA --> C_OK

    M -->|"gpt-general / gpt-5.x + image"| D_MODEL --> D_VAL --> D_FAIL --> D_ABORT
    D_MODEL -.->|"proxy behaviour\n(if request arrived)"| D_NOTE

    style D_VAL fill:#fff3cd,stroke:#ffc107
    style D_FAIL fill:#f8d7da,stroke:#dc3545
    style D_ABORT fill:#f8d7da,stroke:#dc3545
    style A_OK fill:#d4edda,stroke:#28a745
    style B_OK fill:#d4edda,stroke:#28a745
    style C_OK fill:#d4edda,stroke:#28a745
    style D_NOTE fill:#e2e3e5,stroke:#6c757d
```

| Provider | Native vision? | Proxy vision bridge? | Cursor routing | End-to-end result |
|---|---|---|---|---|
| DeepSeek / MiniMax | ❌ No | ✅ Yes — image → text via vision API | Custom base URL (direct) | ✅ Works via bridge |
| Kimi | ✅ Yes | ❌ No — images forwarded as-is | Custom base URL (direct) | ✅ Works natively |
| Azure Anthropic (Claude) | ✅ Yes | ❌ No — images forwarded as-is | Anthropic key path (separate) | ✅ Works natively |
| Azure OpenAI (gpt-general, gpt-5.x) | ✅ Yes | ❌ No — proxy never reached | OpenAI BYOK validation → `api.openai.com` → **401** | ❌ Broken — Cursor bug |

> Azure OpenAI natively supports vision and the proxy would forward images without any bridge — the failure is entirely in Cursor's routing layer. See `known-issues.md` Issue 2 for details and workarounds.

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
