# Azure Anthropic (Claude Family) Flow

## Model Routing

```mermaid
flowchart LR
    Client["Cursor IDE\n(OpenAI format)"]
    Proxy["cursorProxy"]
    AA["Azure Anthropic\nMessages API"]

    Client -->|"model: claude-*\nor cursorproxy/claude-*"| Proxy
    Proxy -->|"AZURE_FOUNDRY_API_KEY\nx-api-key header\nanthropic-version: 2023-06-01"| AA
```

## Request / Response Flow

```mermaid
sequenceDiagram
    participant C as Cursor IDE
    participant P as cursorProxy
    participant KV as KV Store<br/>(Redis / Upstash)
    participant AA as Azure Anthropic<br/>Messages API

    C->>P: POST /v1/chat/completions<br/>model: cursorproxy/claude-sonnet-4-6<br/>messages: [...] (OpenAI format)<br/>thinking: {type:"adaptive"} (optional)

    Note over P: Strip cursorproxy/ prefix<br/>Provider = azureanthropic

    %% Remap input format
    Note over P: Convert OpenAI → Anthropic format<br/>system message → top-level instructions<br/>tool_calls → tool_use blocks<br/>role:tool → tool_result blocks

    %% Claude thinking injection
    alt thinking.type = adaptive
        P->>KV: GET claude_thinking:asst:<normalized_hash>
        alt thinking blocks cached
            KV-->>P: Prior thinking blocks (JSON)
            Note over P: Inject thinking blocks into<br/>prior assistant messages
        end
    end

    P->>AA: POST /anthropic/v1/messages<br/>(Anthropic Messages format)<br/>x-api-key: AZURE_FOUNDRY_API_KEY

    alt streaming response
        loop Anthropic SSE events
            AA-->>P: event: content_block_start/delta/stop<br/>message_start / message_delta / message_stop

            alt thinking block (adaptive thinking active)
                Note over P: thinking_delta → accumulate in memory<br/>signature_delta → accumulate in memory<br/>NOT forwarded to Cursor
            else text content
                Note over P: Map content_block_delta:text_delta<br/>→ OpenAI choices[0].delta.content
                P-->>C: data: {choices:[{delta:{content:"..."}}]}
            else tool_use block
                Note over P: Map input_json_delta<br/>→ OpenAI tool_calls delta
                P-->>C: data: {choices:[{delta:{tool_calls:[...]}}]}
            end
        end

        AA-->>P: event: message_stop
        Note over P: Serialize thinking blocks (if complete + signed)
        P->>KV: SET claude_thinking:asst:<hash> = blocks (forced)
        P-->>C: data: [DONE]

    else non-streaming response
        AA-->>P: {type:"message", content:[...blocks]}
        Note over P: Extract thinking blocks → save to KV<br/>Map text + tool_use blocks → OpenAI format
        P->>KV: SET claude_thinking:asst:<hash> = blocks
        P-->>C: {choices:[{message:{content, tool_calls}}]}<br/>model: cursorproxy/claude-sonnet-4-6
    end
```

## Claude Thinking Block Caching (Adaptive Thinking)

```mermaid
sequenceDiagram
    participant C as Cursor
    participant P as Proxy
    participant KV as KV Store
    participant AA as Azure Anthropic

    Note over C,AA: Turn 1 — no cached thinking yet

    C->>P: thinking: {type:"adaptive"}, messages:[user1]
    P->>AA: forward (no injected thinking)
    AA-->>P: <thinking>...</thinking> + <signature/> + text
    Note over P: Suppress thinking events from Cursor<br/>Accumulate blocks in memory
    P-->>C: text only (no thinking shown)
    P->>KV: SET claude_thinking:asst:<hash1> = [{type:"thinking", thinking:"...", signature:"..."}]

    Note over C,AA: Turn 2 — thinking reused

    C->>P: thinking: {type:"adaptive"}, messages:[user1, asst1, user2]
    P->>KV: GET claude_thinking:asst:<hash1>
    KV-->>P: prior thinking blocks
    Note over P: Inject thinking blocks into asst1 message<br/>Claude skips re-reasoning → faster + cheaper
    P->>AA: messages with injected thinking blocks
    AA-->>P: text (minimal or no new thinking)
    P-->>C: text
    P->>KV: SET claude_thinking:asst:<hash2> = updated blocks
```

## Format Conversion Reference

```mermaid
flowchart LR
    subgraph "Cursor sends (OpenAI)"
        A1["messages: [\n  {role:system, content:...},\n  {role:user, content:...},\n  {role:assistant,\n   tool_calls:[...]},\n  {role:tool, content:...}\n]"]
    end

    subgraph "Proxy converts to (Anthropic)"
        B1["system: '...' (top-level)\nmessages: [\n  {role:user, content:[...]},\n  {role:assistant,\n   content:[{type:tool_use}]},\n  {role:user,\n   content:[{type:tool_result}]}\n]"]
    end

    subgraph "Azure Anthropic returns"
        C1["content: [\n  {type:thinking, ...},\n  {type:text, text:...},\n  {type:tool_use, ...}\n]"]
    end

    subgraph "Proxy returns (OpenAI)"
        D1["choices: [{\n  message: {\n    role: assistant,\n    content: '...',\n    tool_calls: [...]\n  }\n}]"]
    end

    A1 -->|remapAnthropicInput| B1
    B1 -->|upstream call| C1
    C1 -->|mapAnthropicResponseToOpenAI| D1
```

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `AZURE_FOUNDRY_API_KEY` | Shared key for Azure Foundry (Anthropic + OpenAI) |
| `AZURE_ANTHROPIC_ENDPOINT` | Full endpoint URL (overrides AZURE_FOUNDRY_RESOURCE) |
| `AZURE_FOUNDRY_RESOURCE` | Azure resource name (used to build default endpoint) |
| `AZURE_ANTHROPIC_THINKING` | Default thinking mode when request omits `thinking` (`adaptive` or `disabled`) |
| `AZURE_ANTHROPIC_EFFORT` | Default Claude effort when request omits `output_config.effort` (`low`, `medium`, `high`, `max`) |
| `KV_URL` / `KV_TOKEN` | Upstash Redis (Vercel) |
| `REDIS_URL` | Local Redis (Docker) |
| `KV_TTL_SECONDS` | Cache TTL (default 7200 s / 2 h) |
