# Azure OpenAI (GPT / o-series) Flow

## Model Routing

```mermaid
flowchart LR
    Client["Cursor IDE\n(OpenAI format)"]
    Proxy["cursorProxy"]
    AZ["Azure OpenAI\nResponses API"]

    Client -->|"model: gpt-*\nor cursorproxy/gpt-*\nor cursorproxy/o1, o3..."| Proxy
    Client -->|"model: cursorproxy/gpt-general\n(alias)"| Proxy
    Proxy -->|"AZURE_FOUNDRY_API_KEY\napi-key header"| AZ

    subgraph "Alias resolution"
        GG["gpt-general"]
        ENV["AZURE_OPENAI_GENERAL_ALIAS_TARGET\n(e.g. gpt-5.5)"]
        GG -->|resolves via| ENV
    end
```

## Full Request / Response Flow

```mermaid
sequenceDiagram
    participant C as Cursor IDE
    participant P as cursorProxy
    participant KV as KV Store<br/>(Redis / Upstash)
    participant AZ as Azure OpenAI<br/>Responses API

    C->>P: POST /v1/chat/completions<br/>model: cursorproxy/gpt-5.4<br/>messages: [...] OR input: [...]<br/>tools: [{type:"custom", name:"apply_patch",...}]

    Note over P: Strip cursorproxy/ prefix → gpt-5.4<br/>Provider = azureopenai<br/>Resolve alias (gpt-general → real deployment)

    %% Response ID chaining
    P->>KV: GET azresp:<conv_hash_before_last_asst>
    alt response ID cached (prior turn)
        KV-->>P: prev_response_id = "resp_abc..."
        Note over P: Trim input to items AFTER last assistant<br/>Set previous_response_id<br/>Azure replays prior context server-side
    else cache miss (first turn or KV miss)
        Note over P: Send full input array (stateless mode)
    end

    %% Format conversion
    Note over P: messages → input conversion<br/>role:tool → function_call_output<br/>assistant.tool_calls → function_call items<br/>system/developer → instructions field

    %% Tool normalization
    Note over P: apply_patch → kept as native Responses tool<br/>Chat Completions tools → unwrapped inline<br/>Anthropic-format tools → type:function

    %% Sanitize body for reasoning models
    alt gpt-5.x or o-series (reasoning model)
        Note over P: Remove: temperature, top_p,<br/>presence_penalty, frequency_penalty<br/>Map reasoning_effort → reasoning.effort<br/>Apply alias/global effort override
    end

    Note over P: Remap /chat/completions → /responses<br/>Set store: true (enables previous_response_id)

    P->>AZ: POST /openai/responses?api-version=...<br/>model: gpt-5.4 (bare deployment name)<br/>input: [...] (Responses API format)<br/>tools: [{type:"custom",name:"apply_patch",...}]

    alt streaming response
        AZ-->>P: event: response.created<br/>data: {response:{id:"resp_xyz"}}
        Note over P: Capture response ID for KV

        loop SSE events
            AZ-->>P: event: response.output_text.delta
            P-->>C: data: {choices:[{delta:{content:"..."}}]}

            AZ-->>P: event: response.output_item.added (function_call)
            P-->>C: data: {choices:[{delta:{tool_calls:[{index,id,name,arguments:""}]}}]}

            AZ-->>P: event: response.apply_patch_call.delta
            P-->>C: data: {choices:[{delta:{tool_calls:[{index,function:{arguments:"..."}}]}}]}
        end

        AZ-->>P: event: response.completed
        P->>KV: SET azresp:<conv_hash> = resp_xyz (forced)
        P-->>C: data: [DONE]

    else non-streaming response
        AZ-->>P: {id:"resp_xyz", output:[{type:"message",...},{type:"apply_patch_call",...}]}
        Note over P: mapResponsesToOpenAI()<br/>output[].type:message → choices[0].message.content<br/>output[].type:apply_patch_call → tool_calls
        P->>KV: SET azresp:<conv_hash> = resp_xyz
        P-->>C: {choices:[{message:{content, tool_calls}}]}<br/>model: cursorproxy/gpt-5.4
    end
```

## apply_patch Tool Flow (gpt-5.4 — works)

```mermaid
sequenceDiagram
    participant C as Cursor IDE
    participant P as cursorProxy
    participant AZ as Azure OpenAI gpt-5.4

    C->>P: tools: [{type:"custom", name:"apply_patch", format:{...}}]
    Note over P: isKnownResponsesToolType("custom") = true<br/>→ pass through untouched
    P->>AZ: tools: [{type:"custom", name:"apply_patch", format:{...}}]
    AZ-->>P: event: response.apply_patch_call.delta<br/>data: {delta: "*** Begin Patch..."}
    Note over P: Map to OpenAI tool_calls delta<br/>name = "apply_patch"
    P-->>C: data: {choices:[{delta:{tool_calls:[{function:{name:"apply_patch", arguments:"..."}}]}}]}
    Note over C: Cursor applies patch to files
```

## gpt-general Alias — Why apply_patch Is Missing

```mermaid
flowchart TD
    REQ["Cursor decides which tools\nto include in request"]
    CHECK{"Does model name\nmatch gpt-5.x or o-series?"}
    YES["Include apply_patch\nin tools array"]
    NO["Do NOT include\napply_patch"]
    SEND54["Request sent to proxy\nwith apply_patch ✅"]
    SENDGG["Request sent to proxy\nwithout apply_patch ❌"]
    PROXY["cursorProxy receives request"]
    WORKS["Proxy translates apply_patch\n→ Responses API → Azure\n→ patch applied ✅"]
    STUCK["No apply_patch in request\nProxy cannot add it\nFeature unavailable ❌"]

    REQ --> CHECK
    CHECK -->|"cursorproxy/gpt-5.4\nmatches gpt-5.*"| YES --> SEND54 --> PROXY --> WORKS
    CHECK -->|"cursorproxy/gpt-general\nunrecognized alias"| NO --> SENDGG --> PROXY --> STUCK

    style WORKS fill:#d4edda,stroke:#28a745
    style STUCK fill:#f8d7da,stroke:#dc3545
```

## Why the Simple Fix Does Not Work

```mermaid
flowchart TD
    FIX["Proposed fix:\nReturn cursorproxy/gpt-5.5\nin response instead of\ncursorproxy/gpt-general"]
    C1{"Cursor sees gpt-5.5\nin response model field"}
    ROUTE["Cursor routes NEXT request\ndirectly to OpenAI\n(bypasses proxy entirely)"]
    BROKEN["Proxy never receives request\nAzure credentials unused\nRequest fails or hits OpenAI ❌"]
    ALT["gpt-general alias name\nMUST be preserved in responses\nso Cursor keeps routing\nthrough the proxy"]

    FIX --> C1 --> ROUTE --> BROKEN
    FIX -.->|"constraint"| ALT

    style BROKEN fill:#f8d7da,stroke:#dc3545
    style ALT fill:#fff3cd,stroke:#ffc107
```

## Response ID Chaining (Multi-turn Efficiency)

```mermaid
sequenceDiagram
    participant C as Cursor
    participant P as Proxy
    participant KV as KV Store
    participant AZ as Azure OpenAI

    Note over C,AZ: Turn 1

    C->>P: input: [user1]
    P->>KV: GET azresp:<hash([user1])> → miss
    P->>AZ: input: [user1] (full, stateless)
    AZ-->>P: response.id = "resp_001", output: [asst1]
    P->>KV: SET azresp:<hash([user1,asst1])> = "resp_001"
    P-->>C: {choices:[{message:asst1}]}

    Note over C,AZ: Turn 2 — only new input sent

    C->>P: input: [user1, asst1, user2]
    P->>KV: GET azresp:<hash([user1,asst1])> → "resp_001"
    Note over P: Trim to items after asst1 block\n→ input: [user2] only
    P->>AZ: previous_response_id:"resp_001"\ninput: [user2]
    Note over AZ: Azure replays [user1,asst1]\nserver-side — no re-sending
    AZ-->>P: response.id = "resp_002", output: [asst2]
    P->>KV: SET azresp:<hash([user1,asst1,user2,asst2])> = "resp_002"
    P-->>C: {choices:[{message:asst2}]}
```

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `AZURE_FOUNDRY_API_KEY` | Shared key for Azure Foundry |
| `AZURE_OPENAI_ENDPOINT` | Full endpoint URL (overrides resource-based default) |
| `AZURE_FOUNDRY_RESOURCE` | Azure resource name |
| `AZURE_OPENAI_API_VERSION` | API version (default `2025-04-01-preview`) |
| `AZURE_OPENAI_GENERAL_ALIAS_TARGET` | Real deployment behind `gpt-general` (e.g. `gpt-5.5`) |
| `AZURE_OPENAI_GENERAL_REASONING_EFFORT` | Effort override for `gpt-general` requests |
| `AZURE_OPENAI_REASONING_EFFORT` | Global reasoning effort for all reasoning models |
| `KV_URL` / `KV_TOKEN` | Upstash Redis (Vercel) |
| `REDIS_URL` | Local Redis (Docker) |
| `KV_TTL_SECONDS` | Cache TTL (default 7200 s / 2 h) |
