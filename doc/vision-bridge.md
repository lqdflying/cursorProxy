# Vision Bridge

## Cursor ↔ cursorProxy Vision Collaboration

The four provider families take completely different paths when an image is
attached. Cursor's routing decision happens **before** the request reaches the
proxy, based solely on the model name.

```mermaid
flowchart TD
    U["User attaches image in Cursor"]
    M{"Which model family?"}

    %% ── Path A: DeepSeek / MiniMax ──────────────────────────────
    A_MODEL["deepseek-* / minimax-*\n(text-only models)"]
    A_CURSOR["Cursor routes to custom base URL ✅\n(no OpenAI validation — not a GPT brand)"]
    A_GATE["cursorProxy: provider in\nprovidersWithoutVision ✅"]
    A_BRIDGE["Vision Bridge runs\n(see detail below)"]
    A_VIS["Vision API\n(MiniMax VL-01 or gpt-4o-mini)"]
    A_TEXT["image_url → '[Image content: ...]' text"]
    A_DS["DeepSeek / MiniMax API\n(text-only request ✅)"]
    A_RESP_DS["Response → Cursor ✅"]

    %% ── Path B: Kimi ────────────────────────────────────────────
    B_MODEL["kimi-*\n(vision-capable, non-OpenAI brand)"]
    B_CURSOR["Cursor routes to custom base URL ✅\n(no OpenAI validation — not a GPT brand)"]
    B_GATE["cursorProxy: Kimi not in\nprovidersWithoutVision — bridge skipped"]
    B_KIMI["Kimi API\n(native image_url ✅)"]
    B_RESP_KIMI["Response → Cursor ✅"]

    %% ── Path C: Azure Anthropic ─────────────────────────────────
    C_MODEL["claude-*\n(Azure Anthropic)"]
    C_CURSOR["Cursor uses Anthropic key path ✅\n(separate from OpenAI BYOK — not affected)"]
    C_GATE["cursorProxy: forwards natively\n(Azure Anthropic supports vision)"]
    C_AA["Azure Anthropic API\n(native image format ✅)"]
    C_RESP_AA["Response → Cursor ✅"]

    %% ── Path D: Azure OpenAI — BROKEN ───────────────────────────
    D_MODEL["gpt-general / gpt-5.x\n(Azure OpenAI)"]
    D_VAL["Cursor triggers OpenAI BYOK validation:\nGET api.openai.com/v1/models\nAuthorization: Bearer CURSORPROXY_API_KEY\n⚠ hardcoded — ignores custom base URL"]
    D_FAIL["api.openai.com → 401 Unauthorized\n(key is not a real OpenAI key)"]
    D_ABORT["Request aborted ❌\ncursorProxy never reached"]

    U --> M
    M -->|text-only model| A_MODEL --> A_CURSOR --> A_GATE --> A_BRIDGE
    A_BRIDGE -->|per image, bounded concurrency| A_VIS --> A_TEXT --> A_DS --> A_RESP_DS

    M -->|kimi| B_MODEL --> B_CURSOR --> B_GATE --> B_KIMI --> B_RESP_KIMI

    M -->|claude| C_MODEL --> C_CURSOR --> C_GATE --> C_AA --> C_RESP_AA

    M -->|gpt model + image| D_MODEL --> D_VAL --> D_FAIL --> D_ABORT

    style D_VAL fill:#fff3cd,stroke:#ffc107
    style D_FAIL fill:#f8d7da,stroke:#dc3545
    style D_ABORT fill:#f8d7da,stroke:#dc3545
    style A_RESP_DS fill:#d4edda,stroke:#28a745
    style B_RESP_KIMI fill:#d4edda,stroke:#28a745
    style C_RESP_AA fill:#d4edda,stroke:#28a745
```

| Provider | Cursor routing | Proxy action | Works with images? |
|---|---|---|---|
| DeepSeek / MiniMax | Custom base URL (no OpenAI validation) | Vision bridge: image → text description | ✅ Yes — via bridge |
| Kimi | Custom base URL (no OpenAI validation) | Pass through natively | ✅ Yes — native |
| Azure Anthropic (Claude) | Anthropic key path (separate from OpenAI BYOK) | Pass through natively | ✅ Yes — native |
| Azure OpenAI (gpt-general, gpt-5.x) | OpenAI BYOK validation fires first → hardcoded `api.openai.com` → **401** | Never reached | ❌ Broken (Cursor bug) |

> The Azure OpenAI image failure is a Cursor-side bug — see `known-issues.md` Issue 2 for details and workarounds.

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
