# DeepSeek / Kimi / MiniMax Provider Flow

## Model Routing

```mermaid
flowchart LR
    Client["Cursor IDE\n(OpenAI format)"]
    Proxy["cursorProxy"]
    DS["DeepSeek API\napi.deepseek.com"]
    KI["Kimi API\napi.moonshot.ai"]
    MM["MiniMax API\napi.minimax.io"]

    Client -->|"model: deepseek-*"| Proxy
    Client -->|"model: kimi-*"| Proxy
    Client -->|"model: minimax-*"| Proxy
    Proxy -->|DEEPSEEK_API_KEY| DS
    Proxy -->|KIMI_API_KEY| KI
    Proxy -->|MINIMAX_API_KEY| MM
```

## Request / Response Flow

```mermaid
sequenceDiagram
    participant C as Cursor IDE
    participant P as cursorProxy
    participant V as Vision API<br/>(MiniMax VL-01 / GPT-4o-mini)
    participant KV as KV Store<br/>(Redis / Upstash)
    participant UP as Upstream Provider<br/>(DeepSeek / Kimi / MiniMax)

    C->>P: POST /v1/chat/completions<br/>model: cursorproxy/deepseek-reasoner<br/>messages: [...] (may contain images)

    Note over P: Strip cursorproxy/ prefix<br/>Infer provider from model name

    %% Reasoning injection
    P->>KV: GET conv:<hash> (prior reasoning)
    alt reasoning cached
        KV-->>P: reasoning_content / reasoning_details
        Note over P: Inject reasoning into<br/>prior assistant messages
    end

    %% Vision bridge (DeepSeek & MiniMax only)
    alt messages contain image_url (DeepSeek or MiniMax)
        P->>KV: GET img:<sha256> (cache check)
        alt cache miss
            P->>V: Describe image (concurrent, max 2)
            V-->>P: Text description
            P->>KV: SET img:<sha256> = description (TTL 7d, KV_IMAGE_TTL_SECONDS)
        else cache hit
            KV-->>P: Cached description
        end
        Note over P: Replace image_url parts<br/>with text descriptions
    end

    %% DeepSeek-specific
    alt provider = deepseek
        Note over P: Inject thinking: {type:"enabled"}<br/>reasoning_effort: high (or env override)
    end

    %% MiniMax-specific
    alt provider = minimax
        Note over P: Set reasoning_split: true
    end

    P->>UP: POST /v1/chat/completions<br/>(provider API key, modified body)

    alt streaming response
        loop SSE chunks
            UP-->>P: data: {choices:[{delta:{content, reasoning_content}}]}
            Note over P: Buffer reasoning snapshots<br/>every 256+ chars (fire-and-forget KV write)
            P-->>C: data: {choices:[{delta:{content}}]}<br/>(reasoning stripped from client view)
        end
        UP-->>P: data: [DONE]
        P->>KV: SET conv:<hash> = final reasoning (forced)
        P-->>C: data: [DONE]
    else non-streaming response
        UP-->>P: {choices:[{message:{content, reasoning_content}}]}
        P->>KV: SET conv:<hash> = reasoning
        P-->>C: {choices:[{message:{content}}]}<br/>(reasoning stripped, model prefixed cursorproxy/)
    end
```

## Reasoning Caching (Multi-turn Reuse)

```mermaid
flowchart TD
    T1["Turn 1\nUser asks question"]
    R1["DeepSeek reasons...\n(reasoning_content)"]
    C1["Answer streamed to Cursor\nReasoning saved to KV"]

    T2["Turn 2\nUser follow-up"]
    L1["Proxy loads Turn 1 reasoning\nfrom KV"]
    R2["DeepSeek continues\n(has prior reasoning context)"]
    C2["Answer streamed to Cursor"]

    T1 --> R1 --> C1 --> T2 --> L1 --> R2 --> C2
```

## Vision Bridge Detail (DeepSeek & MiniMax)

```mermaid
flowchart LR
    MSG["messages with\nimage_url parts"]
    HASH["SHA-256 hash\nper image"]
    HIT{"KV cache\nhit?"}
    VIS["Vision API call\n(MiniMax VL-01\nor GPT-4o-mini)"]
    DESC["Text description"]
    KVC["Save to KV\n(TTL 7d,\nKV_IMAGE_TTL_SECONDS)"]
    OUT["messages with\ntext descriptions\n(no image_url)"]

    MSG --> HASH --> HIT
    HIT -->|yes| DESC
    HIT -->|no| VIS --> KVC --> DESC
    DESC --> OUT
```

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek auth |
| `KIMI_API_KEY` | Kimi / Moonshot auth |
| `MINIMAX_API_KEY` | MiniMax auth (also used for `minimax_vl` vision backend) |
| `DEEPSEEK_REASONING_EFFORT` | `high` (default) or `max` |
| `VISION_API_PROVIDER` | `minimax_vl` (default) or `openai` |
| `VISION_API_KEY` | API key when `VISION_API_PROVIDER=openai` |
| `VISION_TIMEOUT_MS` | Per-image timeout (default 15 000 ms, 0 = disabled) |
| `VISION_CONCURRENCY` | Max parallel vision calls (default 2) |
| `KV_RETRY_DELAYS_MS` | Reasoning KV retry delays in ms, comma-separated (default `40,120,240,400`) |
| `KV_URL` / `KV_TOKEN` | Upstash Redis (Vercel) |
| `REDIS_URL` | Local Redis (Docker) |
