# Reasoning Bridge

DeepSeek, Kimi, MiniMax, and GLM are reasoning models that expose their chain-of-thought
as a sibling field alongside the answer. The proxy caches this field after each turn
and injects it back into prior assistant messages on subsequent turns — satisfying
the providers' requirement that every prior assistant turn carry its original reasoning.

## Provider Differences

```mermaid
flowchart LR
    subgraph "DeepSeek, Kimi, GLM"
        DS_FIELD["Field: reasoning_content\nType: string\nAccumulation: concatenate deltas\nKV: stored as plain string"]
    end

    subgraph "MiniMax"
        MM_FIELD["Field: reasoning_details\nType: object / array\nAccumulation: replace (last value wins)\nKV: stored as JSON string"]
    end

    subgraph "Azure OpenAI / Azure Anthropic"
        AZ_FIELD["No reasoning field\n(reasoning handled via\nprevious_response_id chaining\nor Claude thinking blocks)"]
    end
```

## Multi-turn Reasoning Flow

```mermaid
sequenceDiagram
    participant C as Cursor
    participant P as cursorProxy
    participant KV as KV Store
    participant UP as Provider<br/>(DeepSeek / Kimi / MiniMax / GLM)

    Note over C,UP: Turn 1 — no prior reasoning

    C->>P: messages: [{role:user, content:"Q1"}]
    P->>KV: GET conv:<hash(messages[0..0])> → miss
    Note over P: No reasoning to inject
    P->>UP: forward (with thinking enabled for DeepSeek)
    UP-->>P: stream: reasoning_content + content

    loop Mid-stream snapshots (fire-and-forget)
        Note over P: Every 256+ chars of new reasoning\n(1 char for MiniMax)
        P-->>KV: SET conv:<hash(messages[0..1])> = reasoning (async)
    end

    UP-->>P: [DONE]
    P->>KV: SET conv:<hash(messages[0..1])> = final reasoning (await)
    P-->>C: content only (reasoning_content stripped)

    Note over C,UP: Turn 2 — reasoning injected

    C->>P: messages: [{role:user,"Q1"}, {role:assistant,"A1"}, {role:user,"Q2"}]
    P->>KV: GET conv:<hash(messages[0..1])> → hit
    KV-->>P: prior reasoning_content
    Note over P: Inject into messages[1]:\n{role:assistant, content:"A1",\n reasoning_content:"<prior thinking>"}
    P->>UP: messages with reasoning injected
    UP-->>P: stream: new reasoning + content
    P->>KV: SET conv:<hash(messages[0..3])> = new reasoning
    P-->>C: content only
```

## Reasoning Accumulation: DeepSeek/Kimi/GLM vs MiniMax

```mermaid
flowchart TD
    subgraph "DeepSeek / Kimi / GLM — concatenate"
        DC1["chunk 1: delta = 'First part'"]
        DC2["chunk 2: delta = ' of reasoning'"]
        DC3["chunk 3: delta = ' continues'"]
        DACC["accReasoning = 'First part of reasoning continues'"]
        DC1 --> DC2 --> DC3 --> DACC
    end

    subgraph "MiniMax — replace (last value wins)"
        MC1["chunk 1: reasoning_details = {summary:'v1'}"]
        MC2["chunk 2: reasoning_details = {summary:'v2'}"]
        MC3["chunk 3: reasoning_details = {summary:'final'}"]
        MACC["accReasoning = {summary:'final'}"]
        MC1 --> MC2 --> MC3 --> MACC
    end
```

> MiniMax sends the complete `reasoning_details` object on each delta, not
> incremental patches. Storing the last-seen value is correct.

## KV Serialization

```mermaid
flowchart LR
    subgraph "Write (serialize)"
        DSW["DeepSeek / Kimi / GLM\nString(reasoning_content)"]
        MMW["MiniMax\nJSON.stringify(reasoning_details)"]
        KVW["KV value\n(always a string)"]
        DSW --> KVW
        MMW --> KVW
    end

    subgraph "Read (deserialize)"
        KVR["KV value\n(string)"]
        DSR["DeepSeek / Kimi / GLM\nuse as-is (string)"]
        MMR["MiniMax\nJSON.parse(value)\n→ object / array"]
        KVR --> DSR
        KVR --> MMR
    end
```

## Placeholder Injection (Cache Miss)

```mermaid
flowchart TD
    MISS["KV miss for assistant turn i\n(turn not seen by proxy,\ncache expired, or KV write lost)"]

    DS_PH["DeepSeek / Kimi\nreasoning_content:\n'(prior reasoning unavailable)'"]
    MM_PH["MiniMax\nreasoning_details:\n[{type:'text', text:'(prior reasoning unavailable)'}]"]
    GLM_MISS["GLM\nleave assistant message unchanged\n(no fabricated reasoning)"]

    WHY["Provider requires non-empty\nreasoning field on ALL prior\nassistant turns — empty string\nfails validation"]

    MISS --> DS_PH
    MISS --> MM_PH
    MISS --> GLM_MISS
    WHY -.->|explains| MISS

    NOTE["Placeholder is never shown\nto Cursor — reasoning fields\nare stripped before responding"]
    DS_PH --> NOTE
    MM_PH --> NOTE
```

GLM/Z.AI preserved thinking is stricter than the other `reasoning_content`
providers: historical reasoning must be returned complete and unmodified. When
the proxy cannot recover a GLM assistant turn from KV, it logs the miss, does not
inject placeholder text, and clears preserved thinking for that request by
setting `thinking.clear_thinking: true`.

## Snapshot Write Strategy

```mermaid
flowchart LR
    DELTA["Reasoning delta\narrives in chunk"]
    SIZE{"New total size ≥\nlast cached + threshold?"}
    DS_T["Threshold:\n256 chars\n(DeepSeek / Kimi / GLM)"]
    MM_T["Threshold:\n1 char\n(MiniMax — any update)"]
    SNAP["Fire-and-forget KV write\n(does NOT block SSE forward path)"]
    SKIP["Skip — not enough\nnew content yet"]
    DONE["[DONE] received"]
    FORCE["Forced await KV write\n(guaranteed durability)"]

    DELTA --> SIZE
    SIZE -->|yes| SNAP
    SIZE -->|no| SKIP
    DS_T -.->|sets| SIZE
    MM_T -.->|sets| SIZE
    DONE --> FORCE
```

> Mid-stream snapshots protect against interrupted streams: if the connection
> drops before `[DONE]`, the next turn still recovers most of the reasoning.

## Reasoning Retry on Injection

When loading prior reasoning at the start of a request, the proxy retries
the KV read to handle the race where the prior turn's stream just finished
and the final write hasn't landed yet.

```
Retry delays (KV_RETRY_DELAYS_MS, default): 40 ms → 120 ms → 240 ms → 400 ms
Max attempts: 5 (1 immediate + 4 retries)
Total max wait: ~800 ms
On DeepSeek/Kimi/MiniMax misses: inject placeholder text
On GLM misses: leave reasoning absent
```

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `KV_RETRY_DELAYS_MS` | `40,120,240,400` | Reasoning KV retry delays (ms, comma-separated) |
| `KV_TTL_SECONDS` | 7 200 | Cache TTL for all reasoning entries |
| `DEEPSEEK_REASONING_EFFORT` | `high` | DeepSeek thinking effort (`high` or `max`) |
| `GLM_REASONING_EFFORT` | `max` | Native GLM (provider `glm`) effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. GLM-5.2+ only; stripped for older GLM. |
| `FIREWORKS_GLM_REASONING_EFFORT` | `max` | Fireworks-hosted GLM 5.2+ effort: `max`, `xhigh`, `high`, `medium`, `low`, `none`. Independent of `GLM_REASONING_EFFORT`. |

## Fireworks GLM 5.2 Reasoning Effort

Fireworks-hosted GLM 5.2+ (`accounts/fireworks/models/glm-5p2`) supports graded
reasoning via `reasoning_effort` (the DeepSeek-V4 mechanism: `high`/`max`, with
`xhigh`→max and `low`/`medium`→high). The proxy resolves the effort on the outbound
request with precedence `FIREWORKS_GLM_REASONING_EFFORT` env → valid client value →
default `max` (matching the native GLM provider). Invalid client values fall back to
`max` and are logged as `FIREWORKS_GLM_INVALID_EFFORT`. The handling is scoped to GLM
5.2+ on Fireworks; older Fireworks GLM and non-GLM Fireworks models pass through
unchanged. The reasoning-restoration bridge is unchanged — it already applies to the
GLM family regardless of account prefix.
