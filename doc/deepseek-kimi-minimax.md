# DeepSeek / Kimi / MiniMax / GLM Provider Flow

## Model Routing

```mermaid
flowchart LR
    Client["Cursor IDE\n(OpenAI format)"]
    Proxy["cursorProxy"]
    DS["DeepSeek API\napi.deepseek.com"]
    KI["Kimi API\napi.moonshot.ai"]
    MM["MiniMax API\napi.minimax.io"]
    GLM["GLM API\nopen.bigmodel.cn"]

    Client -->|"model: deepseek-*"| Proxy
    Client -->|"model: kimi-*"| Proxy
    Client -->|"model: minimax-*"| Proxy
    Client -->|"model: glm-*"| Proxy
    Proxy -->|DEEPSEEK_API_KEY| DS
    Proxy -->|KIMI_API_KEY| KI
    Proxy -->|MINIMAX_API_KEY| MM
    Proxy -->|GLM_API_KEY| GLM
```

## Request / Response Flow

```mermaid
sequenceDiagram
    participant C as Cursor IDE
    participant P as cursorProxy
    participant V as Vision API<br/>(MiniMax VL-01 / GPT-4o-mini)
    participant KV as KV Store<br/>(Redis / Upstash)
    participant UP as Upstream Provider<br/>(DeepSeek / Kimi / MiniMax / GLM)

    C->>P: POST /v1/chat/completions<br/>model: cursorproxy/deepseek-v4-flash<br/>messages: [...] (may contain images)

    Note over P: Strip cursorproxy/ prefix<br/>Infer provider from model name

    %% Reasoning injection
    P->>KV: GET conv:<hash> (prior reasoning)
    alt reasoning cached
        KV-->>P: reasoning_content / reasoning_details
        Note over P: Inject reasoning into<br/>prior assistant messages
    end

    %% Vision bridge (DeepSeek, MiniMax M2.x, GLM-5.2)
    alt messages contain image_url (DeepSeek, MiniMax M2.x, or GLM-5.2)
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

    %% Kimi-specific
    alt provider = kimi and model is kimi-k3 / kimi-k2.7-code / kimi-k2.6 / kimi-k2.5
        Note over P: sanitizeKimiBody()<br/>strip fixed sampling params,<br/>normalize tool_choice,<br/>apply thinking rules
    end

    %% GLM-specific
    alt provider = glm
        Note over P: sanitizeGlmBody()<br/>remap max_completion_tokens,<br/>normalize tool_choice,<br/>enable preserved thinking
    end

    P->>UP: POST /v1/chat/completions<br/>or /chat/completions for GLM<br/>(provider API key, modified body)

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

## Vision Bridge Detail (DeepSeek, MiniMax M2.x, GLM-5.2)

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

## Kimi Request Sanitization

Implementation lives in `lib/kimi.js` (`sanitizeKimiBody`). It runs for Kimi
thinking models before the reasoning bridge injects cached `reasoning_content`.
The default Kimi model is `kimi-k3`.

| Model | Thinking behavior | Proxy action |
|---|---|---|
| `kimi-k3` | Always on; full historical assistant messages must retain reasoning | Delete `thinking`; remove fixed sampling fields; force `reasoning_effort: "max"`; preserve forced `tool_choice` and `max_completion_tokens` |
| `kimi-k2.7-code` | Always on; Preserved Thinking always on; do not pass `thinking` | Delete `thinking`; strip fixed sampling params |
| `kimi-k2.6` | On by default; supports `thinking.keep: "all"` | Inject `{ type: "enabled", keep: "all" }` unless client disables thinking |
| `kimi-k2.5` | On by default; no `keep` support | Inject `{ type: "enabled" }` when omitted; strip `thinking.keep` |

The K2.x tiers also:

- Remove `temperature`, `top_p`, `n`, `presence_penalty`, `frequency_penalty`, and `reasoning_effort` (non-default values 400 upstream)
- Coerce unsupported `tool_choice` to `auto`
- Remap `max_completion_tokens` → `max_tokens` and floor low `max_tokens` to 16k

K3 removes the same fixed sampling fields but keeps `max_completion_tokens`
unchanged and does not rewrite `required` or named function tool choices. Its
reasoning cache scope includes `kimi-k3`; K2.x retains the legacy `kimi:<user>`
scope so existing cached conversations remain valid.

Kimi remains natively multimodal (images and video); the vision bridge is not used.

## TokenRouter (PaleBlueDot)

TokenRouter is a Chat Completions gateway at `https://api.tokenrouter.com/v1`.
cursorProxy matches first-version **family prefixes** and forwards the client
catalog ID unchanged (including `-free` and dated stamps). It does not publish
the rest of TokenRouter's catalog:

| Client model ID (examples) | Upstream ID | Request policy | Vision |
|---|---|---|---|
| `cursorproxy/moonshotai/kimi-k3` (`kimi-k3*`) | as sent | Reuses Kimi K3 sanitizer (`reasoning_effort: "max"`, no `thinking`, no fixed sampling) | Native images |
| `cursorproxy/deepseek/deepseek-v4-pro-0813` (`deepseek-v4-pro*`) | as sent | No native DeepSeek `thinking` / `DEEPSEEK_REASONING_EFFORT` injection | Vision bridge |
| `cursorproxy/deepseek/deepseek-v4-flash-0731` (`deepseek-v4-flash*`) | as sent | Same as Pro | Vision bridge |
| `cursorproxy/qwen/qwen3.8-max` (`qwen3.8-max*`) | as sent | Strip Cursor `thinking`; clamp `reasoning_effort` to `xhigh`/`medium`/`low`; no DashScope `enable_thinking` / `preserve_thinking` | Native images |
| `cursorproxy/z-ai/glm-5.2` (`glm-5.2*`) | as sent | Strip Cursor `thinking`; forward valid `reasoning_effort` (max\|xhigh\|high\|medium\|low\|minimal\|none); no GLM-native `thinking` / `tool_stream` injection; no `max_tokens` remap | Vision bridge |
| `cursorproxy/z-ai/glm-5.3` (`glm-5.3*`) | as sent | Same TokenRouter GLM policy as 5.2. Tried even if the live catalog has not listed it; an upstream 400 is returned as-is. | Vision bridge |

Family prefixes and an optional `tokenrouter/` prefix are matched **before**
native `kimi*` / `deepseek*` / `glm*` rules, so `cursorproxy/kimi-k3`,
`cursorproxy/deepseek-v4-flash`, and `cursorproxy/glm-5.2` still go to
Moonshot, DeepSeek, and GLM respectively.

There is no default TokenRouter model: missing or out-of-allowlist stems on the
`/tokenrouter/v1` route return `400 tokenrouter_model_unsupported`. If
TokenRouter itself rejects an allowlisted ID, that upstream status and body are
passed through. Cursor `developer` roles are rewritten to `system` because
TokenRouter rejects `developer`. Reasoning is restored hit-only under
`tokenrouter:<full-model-id>:<user>` (the forwarded client ID). When a
TokenRouter DeepSeek request carries `tools`, historical `reasoning_content`
is replayed across user turns.

Advertise chosen IDs (including `-free` variants) with `CURSORPROXY_MODELS` and
set `TOKENROUTER_API_KEY`. Optional `UPSTREAM_TOKENROUTER` accepts the base with
or without trailing `/v1`.

## GLM-5.2 Request Sanitization

Implementation lives in `lib/glm.js` (`sanitizeGlmBody`). It runs for GLM models
before the reasoning bridge injects cached `reasoning_content`.

- Default model is `glm-5.2`; `GLM-5.2` is accepted and forwarded to upstream as lowercase.
- Default upstream is ZHIPU China Coding Plan: `https://open.bigmodel.cn/api/coding/paas/v4`.
- Set `UPSTREAM_GLM=https://api.z.ai/api/coding/paas/v4` for the global Z.AI Coding Plan endpoint.
- Compatible gateways (litellm, Hosted_vLLM, OpenRouter-style aggregators) can also be used via `UPSTREAM_GLM`, but they reject the GLM-native fields `thinking` and `tool_stream` with HTTP 400 on plain (no-tools) requests. The proxy auto-detects the native Z.AI/ZHIPU hosts (`open.bigmodel.cn`, `api.z.ai`) via `isNativeGlmEndpoint()` and injects `thinking` / `tool_stream` only there; on any other host both fields are stripped. The detection is endpoint-scoped, not model-scoped: the same `glm-5.2` ID routes differently depending on the upstream host. `GLM_NATIVE_FIELDS` (`auto`/`true`/`false`) overrides the detection — `auto` (default) follows the hostname, `true` always injects, `false` always strips. The reasoning bridge's `clear_thinking` re-injection on KV miss is gated on the native hostname too, so it never re-adds `thinking` to a gateway request. Gateways emit `reasoning_content` in every response by default, so stripping `thinking` does not reduce reasoning quality. `reasoning_effort` is not gated (probed-accepted on gateways, and it is the GLM-5.2+ feature the project specifically forwards).
- The proxy remaps `max_completion_tokens` to `max_tokens`, coerces unsupported forced-tool choices to `auto`, preserves `tool_choice: "none"` by removing tools, and (on native hosts only) sets `tool_stream: true` for streamed tool requests and injects `thinking: { type: "enabled", clear_thinking: false }` when omitted.
- GLM `reasoning_content` is cached and replayed when available. On cache miss, the proxy does not inject placeholder reasoning and sets `clear_thinking: true` for that request because Z.AI requires preserved thinking to remain complete and unmodified.

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek auth |
| `KIMI_API_KEY` | Kimi / Moonshot auth |
| `TOKENROUTER_API_KEY` | PaleBlueDot TokenRouter auth |
| `UPSTREAM_TOKENROUTER` | Optional TokenRouter base URL (default `https://api.tokenrouter.com/v1`) |
| `MINIMAX_API_KEY` | MiniMax auth (also used for `minimax_vl` vision backend) |
| `GLM_API_KEY` | GLM / ZHIPU AI auth |
| `UPSTREAM_GLM` | Optional GLM Coding Plan endpoint override |
| `GLM_NATIVE_FIELDS` | `auto` (default), `true`, `false` — inject/strip `thinking` + `tool_stream` based on native-host detection |
| `DEEPSEEK_REASONING_EFFORT` | `high` (default) or `max` |
| `VISION_API_PROVIDER` | `minimax_vl` (default) or `openai` |
| `VISION_API_KEY` | API key when `VISION_API_PROVIDER=openai` |
| `VISION_TIMEOUT_MS` | Per-image timeout (default 15 000 ms, 0 = disabled) |
| `VISION_CONCURRENCY` | Max parallel vision calls (default 2) |
| `KV_RETRY_DELAYS_MS` | Reasoning KV retry delays in ms, comma-separated (default `40,120,240,400`) |
| `KV_URL` / `KV_TOKEN` | Upstash Redis (Vercel) |
| `REDIS_URL` | Local Redis (Docker) |
