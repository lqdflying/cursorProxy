#!/usr/bin/env node

import crypto from "node:crypto";

class ProbeConfigError extends Error {
  constructor(message, requiredEnv) {
    super(message);
    this.name = "ProbeConfigError";
    this.requiredEnv = requiredEnv;
  }
}

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_RUNS = 6;
const DEFAULT_RESPONSE_CACHE_STRATEGIES = [
  "plain",
  "prompt-key-session-header",
  "implicit-derived-key",
  "prompt-key-store-true",
  "prompt-key-store-false",
  "session-header-only",
  "codex-client-metadata",
];
const LATE_RESPONSE_CACHE_STRATEGIES = ["cache-control-content-blocks"];
const DEFAULT_CHAT_CACHE_STRATEGIES = [
  "chat-session-header-prompt-cache-key",
  "chat-session-header",
  "chat-prompt-cache-key",
  "chat-repeat",
];
const LATE_CHAT_CACHE_STRATEGIES = ["chat-cache-control-content"];

const args = parseArgs(process.argv.slice(2));
normalizeArgAliases(args);
const phaseAliases = {
  "cache-key": "responses-chain",
  "cache-chat-repeat": "chat-cache",
  "cache-previous-response": "upstream-responses",
  "cache-both": "cache-round",
};
const phase = phaseAliases[args.phase] || args.phase || "baseline";
const strategy = args.strategy || defaultStrategyForPhase(phase);
const baseURL = trimTrailingSlash(
  (
    args.baseURL ||
    process.env.PROBE_OPENAICOMPATIBLE_PROXY_URL ||
    ""
  ).trim(),
);
const apiKey =
  args.apiKey ||
  process.env.PROBE_OPENAICOMPATIBLE_API_KEY ||
  "";
const model = args.model || process.env.PROBE_OPENAICOMPATIBLE_MODEL || DEFAULT_MODEL;
const timeoutMs = numberArg(args.timeoutMs, DEFAULT_TIMEOUT_MS);
const streamDefault = boolArg(args.stream, true);
const probeNonce = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

const proxyTarget = {
  apiKey,
  baseURL,
  label: "provider",
  requiredEnv: ["PROBE_OPENAICOMPATIBLE_PROXY_URL", "PROBE_OPENAICOMPATIBLE_API_KEY"],
};

const report = {
  baseURL,
  diagnosis: {
    baseUrlAdvice: baseUrlAdvice(baseURL),
    chatCompletionsWorks: false,
    discrepancies: [],
    keyWorks: false,
    responsesChainWorks: false,
    upstreamResponsesWorks: false,
  },
  model,
  phase,
  runtimeExpectation: runtimeExpectation(baseURL, model),
  startedAt: new Date().toISOString(),
  strategy,
};

try {
  const needsProxyTarget = phase !== "upstream-responses";
  if (needsProxyTarget && (!baseURL || !apiKey)) {
    throw new ProbeConfigError("Missing OpenAI-compatible probe base URL or API key.", proxyTarget.requiredEnv);
  }

  if (phase === "baseline") await runBaseline();
  else if (phase === "params") await runParams();
  else if (phase === "responses-chain") await runResponsesChain(strategy);
  else if (phase === "chat-cache") await runChatCache(strategy);
  else if (phase === "cache-round") await runCacheRound();
  else if (phase === "cache-matrix") await runCacheMatrix();
  else if (phase === "upstream-responses") await runUpstreamResponses(strategy);
  else if (phase === "all") {
    await runBaseline();
    await runParams();
    await runResponsesChain(strategy || "plain");
  } else {
    throw new Error(`Unknown --phase ${phase}`);
  }

  finalizeDiagnosis(report);
  report.providerReport = buildProviderReport(report);
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.fatal = {
    message: error?.message || String(error),
    name: error?.name,
    ...(error?.requiredEnv ? { requiredEnv: error.requiredEnv } : {}),
  };
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exit(error instanceof ProbeConfigError ? 2 : 1);
}

async function runBaseline() {
  await record("models.list", () => request(proxyTarget, "/models", { method: "GET" }));

  await record("chat.minimal", () =>
    request(proxyTarget, "/chat/completions", {
      body: {
        messages: [{ content: "Say exactly: ok", role: "user" }],
        model,
        stream: false,
      },
      method: "POST",
    }),
  );

  await record("chat.stream", () =>
    request(proxyTarget, "/chat/completions", {
      body: {
        messages: [{ content: "Say exactly: ok", role: "user" }],
        model,
        stream: true,
      },
      method: "POST",
    }),
  );
}

async function runParams() {
  const messageBase = {
    messages: [{ content: "Say exactly: ok", role: "user" }],
    model,
    stream: false,
  };

  await record("chat.max_tokens", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, max_tokens: 16 },
      method: "POST",
    }),
  );

  await record("chat.max_output_tokens", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, max_output_tokens: 16 },
      method: "POST",
    }),
  );

  await record("chat.reasoning_effort", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, reasoning_effort: "low" },
      method: "POST",
    }),
  );

  await record("chat.reasoning.nested", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, reasoning: { effort: "low" } },
      method: "POST",
    }),
  );

  await record("chat.verbosity.topLevel", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, verbosity: "low" },
      method: "POST",
    }),
  );

  await record("chat.verbosity.textObject", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, text: { verbosity: "low" } },
      method: "POST",
    }),
  );

  await record("chat.store_false", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, store: false },
      method: "POST",
    }),
  );

  await record("chat.store_false_background", () =>
    request(proxyTarget, "/chat/completions", {
      body: { ...messageBase, background: true, store: false },
      method: "POST",
    }),
  );

  await record("chat.native_input_array", () =>
    request(proxyTarget, "/chat/completions", {
      body: {
        input: [{ content: "Say exactly: ok", role: "user" }],
        model,
        stream: false,
      },
      method: "POST",
    }),
  );
}

async function runResponsesChain(selectedStrategy) {
  return runResponsesChainStrategy(selectedStrategy, {});
}

async function runResponsesChainStrategy(selectedStrategy, options = {}) {
  const config = responseChainStrategy(selectedStrategy);
  const runs = numberArg(args.runs, DEFAULT_CACHE_RUNS);
  const pauseMs = numberArg(args.pauseMs, 1_500);
  const promptCacheKey = options.promptCacheKey || args.cacheKey || defaultCacheKey("responses");
  const stream = boolArg(args.stream, streamDefault);
  const rounds = [];
  let history = [
    chatMessage("system", longStablePrefix(), { cacheControlBlocks: config.cacheControlBlocks }),
    chatMessage(
      "user",
      "Stable first user turn for OpenAI-compatible response-id chaining. Answer with ok when asked.",
      { cacheControlBlocks: config.cacheControlBlocks },
    ),
  ];

  for (let i = 0; i < runs; i += 1) {
    const userTurn = chatMessage(
      "user",
      `OpenAI-compatible Responses-chain probe round ${i + 1}. Say exactly: ok`,
      { cacheControlBlocks: config.cacheControlBlocks },
    );
    const messages = [...history, userTurn];
    const body = {
      messages,
      model,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    if (config.includePromptCacheKey) body.prompt_cache_key = promptCacheKey;
    if (config.clientMetadata) body.client_metadata = hydrateCacheKey(config.clientMetadata, promptCacheKey);
    if (config.store !== undefined) body.store = config.store;
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;

    const headers = { ...config.headers };
    for (const [name, value] of Object.entries(headers)) {
      if (value === "{cacheKey}") headers[name] = promptCacheKey;
    }

    const result = await record(`responses-chain.${selectedStrategy}.round${i + 1}`, () =>
      request(proxyTarget, "/chat/completions", { body, headers, method: "POST" }),
    );
    rounds.push(result);

    const sample = result.textSample && result.textSample !== "[DONE]" ? result.textSample : "";
    if (result.ok) {
      history = [
        ...messages,
        chatMessage("assistant", sample || "ok", { cacheControlBlocks: config.cacheControlBlocks }),
      ];
    }
    if (i + 1 < runs) await sleep(pauseMs);
  }

  const summary = summarizeCacheResults(selectedStrategy, rounds, {
    endpoint: "/chat/completions",
    mode: "public-chat-boundary-to-responses",
    promptCacheKey: config.includePromptCacheKey ? promptCacheKey : null,
    strategyDescription: config.description,
  });
  if (!options.skipReportSummary) report.cacheSummary = summary;
  return summary;
}

async function runChatCache(selectedStrategy) {
  return runChatCacheStrategy(selectedStrategy, {});
}

async function runChatCacheStrategy(selectedStrategy, options = {}) {
  const config = chatCacheStrategy(selectedStrategy);
  const runs = numberArg(args.runs, DEFAULT_CACHE_RUNS);
  const pauseMs = numberArg(args.pauseMs, 1_500);
  const promptCacheKey = options.promptCacheKey || args.cacheKey || defaultCacheKey("chat");
  const stream = boolArg(args.stream, true);
  const results = [];

  for (let i = 0; i < runs; i += 1) {
    const body = {
      messages: chatCacheMessages(i, { cacheControlBlocks: config.cacheControlBlocks }),
      model,
      stream,
      ...(stream && boolArg(args.includeUsage, false) ? { stream_options: { include_usage: true } } : {}),
    };
    if (config.includePromptCacheKey) body.prompt_cache_key = promptCacheKey;

    const headers = { ...config.headers };
    for (const [name, value] of Object.entries(headers)) {
      if (value === "{cacheKey}") headers[name] = promptCacheKey;
    }

    const result = await record(`chat-cache.${selectedStrategy}.round${i + 1}`, () =>
      request(proxyTarget, "/chat/completions", { body, headers, method: "POST" }),
    );
    results.push(result);
    if (i + 1 < runs) await sleep(pauseMs);
  }

  const summary = summarizeCacheResults(selectedStrategy, results, {
    endpoint: "/chat/completions",
    mode: "chat-completions-cache",
    promptCacheKey: config.includePromptCacheKey ? promptCacheKey : null,
    strategyDescription: config.description,
  });
  if (!options.skipReportSummary) report.cacheSummary = summary;
  return summary;
}

async function runCacheRound() {
  const endpointScope = args.endpoint || args.matrixEndpoint || "responses";
  const confirmedResponseStrategy = stringArg(args.confirmedResponseStrategy);
  const confirmedChatStrategy = stringArg(args.confirmedChatStrategy);
  const responseStrategy = args.responseStrategy || args.strategy || "prompt-key-session-header";
  const chatStrategy =
    args.chatStrategy ||
    (["chat", "chat-completions", "chatCompletions"].includes(endpointScope) && args.strategy
      ? args.strategy
      : "chat-session-header-prompt-cache-key");
  const responseCacheKey = args.responseCacheKey || cacheBothKey(`round-responses-${responseStrategy}`);
  const chatCacheKey = args.chatCacheKey || cacheBothKey(`round-chat-completions-${chatStrategy}`);
  const testResponses =
    ["both", "responses", "response"].includes(endpointScope) && !confirmedResponseStrategy;
  const testChat =
    ["both", "chat", "chat-completions", "chatCompletions"].includes(endpointScope) &&
    !confirmedChatStrategy;

  const responseSummary =
    confirmedResponseStrategy
      ? confirmedCacheSummary("Chat-boundary Responses mode", confirmedResponseStrategy)
      : testResponses
        ? await runResponsesChainStrategy(responseStrategy, {
            promptCacheKey: responseCacheKey,
            skipReportSummary: true,
          })
        : null;
  const chatSummary =
    confirmedChatStrategy
      ? confirmedCacheSummary("Chat Completions mode", confirmedChatStrategy)
      : testChat
        ? await runChatCacheStrategy(chatStrategy, {
            promptCacheKey: chatCacheKey,
            skipReportSummary: true,
          })
        : null;

  report.cacheSummary = {
    chatCompletions: chatSummary,
    comparison: summarizeCacheComparison(responseSummary, chatSummary),
    responses: responseSummary,
    round: summarizeCacheRound({
      chatStrategy,
      confirmedChatStrategy,
      confirmedResponseStrategy,
      endpointScope,
      responseStrategy,
      testChat,
      testResponses,
    }),
  };
}

async function runCacheMatrix() {
  const endpointScope = args.endpoint || args.matrixEndpoint || "responses";
  const includeLateStrategies =
    args.includeLateStrategies === true ||
    args.includeLateStrategies === "true" ||
    args.matrixMode === "full" ||
    args.matrixMode === "all";
  const responseStrategies = parseListArg(args.responseStrategies, [
    ...DEFAULT_RESPONSE_CACHE_STRATEGIES,
    ...(includeLateStrategies ? LATE_RESPONSE_CACHE_STRATEGIES : []),
  ]);
  const chatStrategies = parseListArg(args.chatStrategies, [
    ...DEFAULT_CHAT_CACHE_STRATEGIES,
    ...(includeLateStrategies ? LATE_CHAT_CACHE_STRATEGIES : []),
  ]);
  const confirmedResponseStrategy = stringArg(args.confirmedResponseStrategy);
  const confirmedChatStrategy = stringArg(args.confirmedChatStrategy);
  const testResponses =
    ["both", "responses", "response"].includes(endpointScope) && !confirmedResponseStrategy;
  const testChat =
    ["both", "chat", "chat-completions", "chatCompletions"].includes(endpointScope) &&
    !confirmedChatStrategy;
  const responseSummaries = [];
  const chatSummaries = [];

  if (testResponses) {
    for (const matrixStrategy of responseStrategies) {
      responseSummaries.push(
        await safeRunCacheMatrixStrategy({
          endpoint: "Chat-boundary Responses mode",
          runner: () =>
            runResponsesChainStrategy(matrixStrategy, {
              promptCacheKey: cacheBothKey(`matrix-responses-${matrixStrategy}`),
              skipReportSummary: true,
            }),
          strategy: matrixStrategy,
        }),
      );
    }
  }

  if (testChat) {
    for (const matrixStrategy of chatStrategies) {
      chatSummaries.push(
        await safeRunCacheMatrixStrategy({
          endpoint: "Chat Completions mode",
          runner: () =>
            runChatCacheStrategy(matrixStrategy, {
              promptCacheKey: cacheBothKey(`matrix-chat-${matrixStrategy}`),
              skipReportSummary: true,
            }),
          strategy: matrixStrategy,
        }),
      );
    }
  }

  const responseSummary =
    confirmedResponseStrategy
      ? confirmedCacheSummary("Chat-boundary Responses mode", confirmedResponseStrategy)
      : bestCacheSummary(responseSummaries);
  const chatSummary =
    confirmedChatStrategy
      ? confirmedCacheSummary("Chat Completions mode", confirmedChatStrategy)
      : bestCacheSummary(chatSummaries);

  report.cacheSummary = {
    chatCompletions: chatSummary,
    comparison: summarizeCacheComparison(responseSummary, chatSummary),
    matrix: summarizeCacheMatrix({
      chatStrategies,
      chatSummaries,
      confirmedChatStrategy,
      confirmedResponseStrategy,
      endpointScope,
      includeLateStrategies,
      responseStrategies,
      responseSummaries,
      testChat,
      testResponses,
    }),
    responses: responseSummary,
  };
}

async function safeRunCacheMatrixStrategy({ endpoint, runner, strategy }) {
  try {
    return await runner();
  } catch (error) {
    return {
      endpoint,
      fatal: {
        message: error?.message || String(error),
        name: error?.name,
      },
      likelyHit: false,
      note:
        "Strategy failed before a complete cache summary was available. Retry once before treating this as a provider rejection.",
      rounds: [],
      strategy,
    };
  }
}

async function runUpstreamResponses(selectedStrategy) {
  const upstreamBaseURL = trimTrailingSlash(
    (
      args.upstreamBaseURL ||
      process.env.PROBE_OPENAICOMPATIBLE_UPSTREAM_PROXY_URL ||
      process.env.PROBE_OPENAICOMPATIBLE_PROXY_URL ||
      ""
    ).trim(),
  );
  const upstreamApiKey =
    args.upstreamApiKey ||
    process.env.PROBE_OPENAICOMPATIBLE_UPSTREAM_API_KEY ||
    process.env.PROBE_OPENAICOMPATIBLE_API_KEY ||
    "";
  const upstreamModel =
    args.upstreamModel ||
    process.env.PROBE_OPENAICOMPATIBLE_UPSTREAM_MODEL ||
    process.env.PROBE_OPENAICOMPATIBLE_MODEL ||
    model;

  if (!upstreamBaseURL || !upstreamApiKey) {
    throw new ProbeConfigError("Missing direct upstream probe base URL or API key.", [
      "PROBE_OPENAICOMPATIBLE_PROXY_URL or PROBE_OPENAICOMPATIBLE_UPSTREAM_PROXY_URL",
      "PROBE_OPENAICOMPATIBLE_API_KEY or PROBE_OPENAICOMPATIBLE_UPSTREAM_API_KEY",
    ]);
  }

  const upstreamTarget = {
    apiKey: upstreamApiKey,
    baseURL: upstreamBaseURL,
    label: "upstream",
    requiredEnv: [
      "PROBE_OPENAICOMPATIBLE_PROXY_URL or PROBE_OPENAICOMPATIBLE_UPSTREAM_PROXY_URL",
      "PROBE_OPENAICOMPATIBLE_API_KEY or PROBE_OPENAICOMPATIBLE_UPSTREAM_API_KEY",
    ],
  };
  const promptCacheKey =
    args.cacheKey ||
    `cursorproxy_probe_upstream_${sha256(`${upstreamBaseURL}|${upstreamModel}|upstream`).slice(0, 24)}`;
  const config = upstreamResponseStrategy(selectedStrategy, promptCacheKey);
  const runs = numberArg(args.runs, DEFAULT_CACHE_RUNS);
  const pauseMs = numberArg(args.pauseMs, 1_500);

  await record("upstream.models.list", () => request(upstreamTarget, "/models", { method: "GET" }));

  const rounds = [];
  let previousResponseId = null;
  let previousResponseIdWorks = false;

  for (let i = 0; i < runs; i += 1) {
    const body = {
      input: upstreamResponseInput(i),
      model: upstreamModel,
      store: true,
      stream: boolArg(args.stream, true),
    };
    if (i === 0) body.reasoning = { effort: "low" };
    if (config.includePromptCacheKey) body.prompt_cache_key = promptCacheKey;
    if (previousResponseId && (i === 1 || (i > 1 && previousResponseIdWorks))) {
      body.previous_response_id = previousResponseId;
    }

    const result = await record(`upstream.responses.round${i + 1}`, () =>
      request(upstreamTarget, "/responses", {
        body,
        headers: config.headers,
        method: "POST",
      }),
    );
    rounds.push(result);

    if (result.ok && result.responseId) {
      previousResponseId = result.responseId;
      if (i === 1) previousResponseIdWorks = true;
    } else if (i === 1) {
      previousResponseIdWorks = false;
    }

    if (i + 1 < runs) await sleep(pauseMs);
  }

  report.cacheSummary = summarizeCacheResults(selectedStrategy, rounds, {
    mode: "direct-upstream-responses",
    previousResponseId,
    promptCacheKey: config.includePromptCacheKey ? promptCacheKey : null,
    strategyDescription: config.description,
  });
}

async function record(name, fn) {
  const startedAt = Date.now();
  const result = await fn();
  const entry = {
    durationMs: Date.now() - startedAt,
    name,
    ...result,
  };
  if (!report.results) report.results = [];
  report.results.push(entry);
  return entry;
}

async function request(target, path, { body, headers: extraHeaders = {}, method }) {
  const headers = {
    Authorization: `Bearer ${target.apiKey}`,
    ...extraHeaders,
  };
  let requestBody;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(joinUrl(target.baseURL, path), {
    body: requestBody,
    headers,
    method,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const parsed = parseResponseBody(raw, contentType);
  const finalResponse = extractFinalResponse(parsed);
  const usage = extractUsage(parsed, finalResponse);
  const cacheSignals = extractCacheSignals(usage, parsed, finalResponse);

  return {
    cacheSignals,
    cachedTokens: cacheSignals.cacheReadTokens,
    contentType,
    diagnosticHeaders: extractDiagnosticHeaders(response.headers),
    errorDetail: extractErrorDetail(parsed, raw),
    eventTypes: eventTypes(parsed),
    ok: response.ok,
    object: parsed.json?.object || finalResponse?.object || firstEventObject(parsed),
    path,
    requestId:
      response.headers.get("x-request-id") ||
      response.headers.get("x-client-request-id") ||
      response.headers.get("x-vercel-id") ||
      null,
    responseId: extractResponseId(parsed, finalResponse),
    status: response.status,
    target: target.label,
    textSample: extractTextSample(parsed, raw),
    usage,
  };
}

function parseResponseBody(raw, contentType) {
  const isSSE = contentType.includes("text/event-stream") || raw.trimStart().startsWith("event:") || raw.trimStart().startsWith("data:");
  if (isSSE) return { events: parseSSE(raw), json: null, rawSnippet: snippet(raw) };

  try {
    return { events: [], json: JSON.parse(raw), rawSnippet: snippet(raw) };
  } catch {
    return { events: [], json: null, rawSnippet: snippet(raw) };
  }
}

function parseSSE(raw) {
  const events = [];
  const blocks = raw.replaceAll("\r\n", "\n").split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;

    let eventName = "";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    const dataRaw = dataLines.join("\n");
    if (!dataRaw || dataRaw === "[DONE]") {
      events.push({ data: dataRaw, event: eventName });
      continue;
    }

    let data;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      data = dataRaw;
    }
    events.push({ data, event: eventName });
  }

  return events;
}

function extractFinalResponse(parsed) {
  if (parsed.json?.object === "response") return parsed.json;
  if (parsed.json?.response?.object === "response") return parsed.json.response;
  if (parsed.json?.object === "chat.completion") return parsed.json;

  for (let i = parsed.events.length - 1; i >= 0; i -= 1) {
    const data = parsed.events[i].data;
    if (data?.type === "response.completed" && data.response) return data.response;
    if (data?.response?.object === "response") return data.response;
    if (data?.object === "chat.completion") return data;
  }

  return null;
}

function extractUsage(parsed, finalResponse) {
  return collectUsageObjects(parsed, finalResponse)[0]?.value || null;
}

function extractCacheSignals(usage, parsed, finalResponse) {
  const candidates = [];
  const usageObjects = collectUsageObjects(parsed, finalResponse);
  if (usage && !usageObjects.some((entry) => entry.value === usage)) {
    usageObjects.unshift({ path: "selected.usage", value: usage });
  }

  const usageReadPaths = [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "input_tokens_details.cached_tokens",
    "inputTokensDetails.cachedTokens",
    "prompt_tokens_details.cached_tokens",
    "promptTokensDetails.cachedTokens",
    "cached_tokens",
    "cachedTokens",
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
    "cachedContentTokenCount",
    "usageMetadata.cachedContentTokenCount",
    "usage_metadata.cachedContentTokenCount",
    "usage_metadata.cached_content_token_count",
  ];
  const usageCreationPaths = [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "input_tokens_details.cached_creation_tokens",
    "inputTokensDetails.cachedCreationTokens",
    "prompt_tokens_details.cached_creation_tokens",
    "promptTokensDetails.cachedCreationTokens",
    "cached_creation_tokens",
    "cachedCreationTokens",
    "cache_creation_tokens",
    "cacheCreationTokens",
  ];
  const usageMissPaths = [
    "prompt_cache_miss_tokens",
    "promptCacheMissTokens",
    "cache_miss_input_tokens",
    "cacheMissInputTokens",
  ];

  for (const entry of usageObjects) {
    for (const path of usageReadPaths) {
      addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.${path}`, readPath(entry.value, path));
    }
    for (const path of usageCreationPaths) {
      addSignalCandidate(candidates, "cacheCreationTokens", `${entry.path}.${path}`, readPath(entry.value, path));
    }
    for (const path of usageMissPaths) {
      addSignalCandidate(candidates, "cacheMissTokens", `${entry.path}.${path}`, readPath(entry.value, path));
    }
  }

  const topLevelRoots = [
    { path: "json", value: parsed.json },
    { path: "finalResponse", value: finalResponse },
  ];
  for (const entry of topLevelRoots) {
    addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.input_tokens_details.cached_tokens`, readPath(entry.value, "input_tokens_details.cached_tokens"));
    addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.inputTokensDetails.cachedTokens`, readPath(entry.value, "inputTokensDetails.cachedTokens"));
    addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.prompt_tokens_details.cached_tokens`, readPath(entry.value, "prompt_tokens_details.cached_tokens"));
    addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.promptTokensDetails.cachedTokens`, readPath(entry.value, "promptTokensDetails.cachedTokens"));
    addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.usageMetadata.cachedContentTokenCount`, readPath(entry.value, "usageMetadata.cachedContentTokenCount"));
    addSignalCandidate(candidates, "cacheReadTokens", `${entry.path}.usage_metadata.cachedContentTokenCount`, readPath(entry.value, "usage_metadata.cachedContentTokenCount"));
  }
  addSignalCandidate(candidates, "cacheReadTokens", "json.timings.cache_n", parsed.json?.timings?.cache_n);

  return {
    cacheCreationTokens: selectSignal(candidates, "cacheCreationTokens"),
    cacheMissTokens: selectSignal(candidates, "cacheMissTokens"),
    cacheReadTokens: selectSignal(candidates, "cacheReadTokens"),
    candidates,
  };
}

function collectUsageObjects(parsed, finalResponse) {
  const entries = [];
  addObjectEntry(entries, "finalResponse.usage", finalResponse?.usage);
  addObjectEntry(entries, "json.usage", parsed.json?.usage);
  addObjectEntry(entries, "json.response.usage", parsed.json?.response?.usage);
  addObjectEntry(entries, "json.message.usage", parsed.json?.message?.usage);
  if (Array.isArray(parsed.json?.choices)) {
    parsed.json.choices.forEach((choice, index) => {
      addObjectEntry(entries, `json.choices.${index}.usage`, choice?.usage);
    });
  }

  parsed.events.forEach((event, index) => {
    const data = event.data;
    addObjectEntry(entries, `events.${index}.data.usage`, data?.usage);
    addObjectEntry(entries, `events.${index}.data.message.usage`, data?.message?.usage);
    addObjectEntry(entries, `events.${index}.data.response.usage`, data?.response?.usage);
    addObjectEntry(entries, `events.${index}.data.delta.usage`, data?.delta?.usage);
    if (Array.isArray(data?.choices)) {
      data.choices.forEach((choice, choiceIndex) => {
        addObjectEntry(entries, `events.${index}.data.choices.${choiceIndex}.usage`, choice?.usage);
      });
    }
  });

  return entries;
}

function addObjectEntry(entries, path, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) entries.push({ path, value });
}

function addSignalCandidate(candidates, kind, path, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return;
  candidates.push({ kind, path, value: Math.trunc(n) });
}

function selectSignal(candidates, kind) {
  const matches = candidates.filter((candidate) => candidate.kind === kind);
  const positive = matches.find((candidate) => candidate.value > 0);
  if (positive) return positive.value;
  const zero = matches.find((candidate) => candidate.value === 0);
  return zero ? 0 : null;
}

function readPath(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value);
}

function extractDiagnosticHeaders(headers) {
  const names = [
    "cf-cache-status",
    "openai-processing-ms",
    "x-cache",
    "x-client-request-id",
    "x-litellm-cache-hit",
    "x-litellm-call-id",
    "x-new-api-cache-hit",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-request-id",
    "x-vercel-id",
  ];
  const result = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function extractResponseId(parsed, finalResponse) {
  if (finalResponse?.id) return finalResponse.id;
  if (parsed.json?.id) return parsed.json.id;

  for (let i = parsed.events.length - 1; i >= 0; i -= 1) {
    const data = parsed.events[i].data;
    if (data?.id) return data.id;
    if (data?.response?.id) return data.response.id;
    if (data?.type === "response.created" && data?.response?.id) return data.response.id;
  }

  return null;
}

function extractTextSample(parsed, raw) {
  if (parsed.json?.choices?.[0]?.message?.content) return parsed.json.choices[0].message.content;
  if (parsed.json?.output_text) return parsed.json.output_text;

  const deltas = [];
  for (const event of parsed.events) {
    const data = event.data;
    const chatDelta = data?.choices?.[0]?.delta;
    if (typeof chatDelta?.content === "string") deltas.push(chatDelta.content);
    if (typeof chatDelta?.refusal === "string") deltas.push(chatDelta.refusal);
    if (data?.type === "response.output_text.delta") deltas.push(data.delta || "");
    if (data?.type === "response.output_text.done" && data.text && deltas.length === 0) deltas.push(data.text);
  }
  if (deltas.length > 0) return deltas.join("").slice(0, 300);

  return snippet(raw, 300);
}

function extractErrorDetail(parsed, raw) {
  return (
    parsed.json?.detail ||
    parsed.json?.error?.message ||
    parsed.json?.message ||
    firstEventError(parsed) ||
    (!parsed.json && raw.includes("<html") ? "HTML response body" : null)
  );
}

function firstEventError(parsed) {
  for (const event of parsed.events) {
    const data = event.data;
    if (data?.error?.message) return data.error.message;
    if (data?.error && typeof data.error === "string") return data.error;
  }
  return null;
}

function firstEventObject(parsed) {
  for (const event of parsed.events) {
    if (event.data?.object) return event.data.object;
    if (event.data?.response?.object) return event.data.response.object;
  }
  return null;
}

function eventTypes(parsed) {
  return parsed.events.map((event) => event.event || event.data?.type || event.data?.object).filter(Boolean);
}

function finalizeDiagnosis(currentReport) {
  const results = currentReport.results || [];
  const byName = Object.fromEntries(results.map((result) => [result.name, result]));
  const models = byName["models.list"];
  const chat = byName["chat.minimal"] || results.find((result) => result.name.startsWith("responses-chain."));
  const chainRounds = results.filter((result) => result.name.startsWith("responses-chain."));
  const upstreamRounds = results.filter((result) => result.name.startsWith("upstream.responses."));

  currentReport.diagnosis.keyWorks = Boolean(
    models?.ok || chat?.ok || results.some((result) => result.status === 200),
  );
  currentReport.diagnosis.chatCompletionsWorks = Boolean(chat?.ok);
  currentReport.diagnosis.responsesChainWorks = chainRounds.length > 0 && chainRounds.every((round) => round.ok);
  currentReport.diagnosis.upstreamResponsesWorks = upstreamRounds.length > 0 && upstreamRounds.every((round) => round.ok);

  const explicitCursorProxyRoute = /\/openaicompat\/v1$/i.test(baseURL);

  if (!baseURL.endsWith("/v1")) {
    currentReport.diagnosis.discrepancies.push(
      "Probe base URL should normally end in /v1. Direct upstream providers usually expose /v1; cursorProxy validation may use /openaicompat/v1.",
    );
  }

  if (!explicitCursorProxyRoute && /^(?:cursorproxy\/)?compatible-/i.test(model)) {
    currentReport.diagnosis.discrepancies.push(
      "A compatible-* model is a cursorProxy alias. Direct upstream pre-detection should use a native provider model id from /models, for example gpt-5.5.",
    );
  }

  if (explicitCursorProxyRoute && /^(?:cursorproxy\/)?gpt-|^(?:cursorproxy\/)?o\d/i.test(model)) {
    currentReport.diagnosis.discrepancies.push(
      "cursorProxy /openaicompat/v1 validation with a gpt-/o-series model may need a compatible-* alias to avoid unified-route provider inference.",
    );
  }

  if (chat?.ok && chat.object === "response") {
    currentReport.diagnosis.discrepancies.push(
      "Public Chat Completions returned a raw Responses object. cursorProxy should map Responses output back to Chat Completions on /chat/completions.",
    );
  }

  const storeBackground = byName["chat.store_false_background"];
  const expectedWireApi = String(args.expectedWireApi || process.env.OPENAICOMPAT_WIRE_API || "").toLowerCase();
  if (expectedWireApi === "responses" && storeBackground && storeBackground.status !== 400) {
    currentReport.diagnosis.discrepancies.push(
      "Expected store:false + background:true to return 400 store_background_conflict in Responses mode.",
    );
  }

  const firstChain = chainRounds[0];
  if (chainRounds.length > 0 && !firstChain?.responseId) {
    currentReport.diagnosis.discrepancies.push(
      "First public-boundary Responses-chain round did not expose a response id in the mapped response/stream. Check STREAM_OAI_RESP_ID logs.",
    );
  }

  const laterChainFailure = chainRounds.slice(1).find((round) => !round.ok);
  if (laterChainFailure) {
    currentReport.diagnosis.discrepancies.push(
      `A later Responses-chain round failed (${laterChainFailure.status}: ${laterChainFailure.errorDetail || "unknown"}). Check previous_response_id fallback logs.`,
    );
  }
}

function buildProviderReport(currentReport) {
  const apiBehavior = {
    chatCompletions: buildEndpointReport(currentReport, {
      endpoint: "/chat/completions",
      label: "Chat Completions public boundary",
    }),
    responses: buildResponsesModeReport(currentReport),
    upstreamResponses: buildEndpointReport(currentReport, {
      endpoint: "/responses",
      label: "Direct upstream Responses API",
      target: "upstream",
    }),
  };
  const cacheBehavior = buildCacheBehaviorReport(currentReport.cacheSummary);

  return {
    apiBehavior,
    cacheBehavior,
    recommendations: buildRecommendations(apiBehavior, cacheBehavior),
    summary: buildProviderSummary(apiBehavior, cacheBehavior),
  };
}

function buildResponsesModeReport(currentReport) {
  const chainResults = (currentReport.results || []).filter((result) =>
    result.name.startsWith("responses-chain."),
  );
  const okResults = chainResults.filter((result) => result.ok && isExpectedEndpointShape(result, "/chat/completions"));
  return {
    acceptedCalls: okResults.map((result) => ({
      contentType: result.contentType,
      name: result.name,
      requestId: result.requestId,
      responseId: result.responseId,
      status: result.status,
    })),
    endpoint: "/chat/completions",
    label: "Chat-boundary Responses mode via /chat/completions",
    notes:
      chainResults.length > 0
        ? ["Verify response-ID chaining in cursorProxy logs; cache usage fields are supporting evidence."]
        : ["Responses-mode chaining was not tested in this phase."],
    rejectedCalls: chainResults
      .filter((result) => !result.ok || !isExpectedEndpointShape(result, "/chat/completions"))
      .map((result) => ({
        error: result.errorDetail || endpointShapeError(result, "/chat/completions") || String(result.status),
        name: result.name,
        status: result.status,
      })),
    usageCachePaths: unique(
      chainResults.flatMap((result) =>
        (result.cacheSignals?.candidates || [])
          .filter((candidate) => candidate.kind === "cacheReadTokens")
          .map((candidate) => candidate.path),
      ),
    ),
    works: okResults.length > 0,
  };
}

function buildEndpointReport(currentReport, { endpoint, label, target }) {
  const results = (currentReport.results || []).filter(
    (result) => result.path === endpoint && (!target || result.target === target),
  );
  const okResults = results.filter((result) => result.ok && isExpectedEndpointShape(result, endpoint));
  const rejected = results
    .filter((result) => !result.ok || !isExpectedEndpointShape(result, endpoint))
    .map((result) => ({
      error: result.errorDetail || endpointShapeError(result, endpoint) || String(result.status),
      name: result.name,
      status: result.status,
    }));
  const cacheReadValues = results
    .map((result) => result.cacheSignals?.cacheReadTokens)
    .filter((value) => Number.isFinite(Number(value)));
  const usageCachePaths = unique(
    results.flatMap((result) =>
      (result.cacheSignals?.candidates || [])
        .filter((candidate) => candidate.kind === "cacheReadTokens")
        .map((candidate) => candidate.path),
    ),
  );
  const notes = [];
  if (endpoint === "/chat/completions" && cacheReadValues.length === 0) {
    notes.push("No cache usage field was exposed by observed Chat Completions responses.");
  }
  return {
    acceptedCalls: okResults.map((result) => ({
      contentType: result.contentType,
      name: result.name,
      requestId: result.requestId,
      responseId: result.responseId,
      status: result.status,
    })),
    endpoint,
    label,
    notes,
    rejectedCalls: rejected,
    usageCachePaths,
    works: okResults.length > 0,
  };
}

function isExpectedEndpointShape(result, endpoint) {
  if (!result?.ok) return false;
  if (endpoint === "/chat/completions") {
    return result.object === "chat.completion" || result.object === "chat.completion.chunk";
  }
  if (endpoint === "/responses") {
    return result.object === "response" || result.responseId;
  }
  if (endpoint === "/models") {
    return result.object === "list";
  }
  return true;
}

function endpointShapeError(result, endpoint) {
  if (!result?.ok) return "";
  if (endpoint === "/chat/completions") {
    return `HTTP ${result.status} did not return Chat Completions JSON/SSE`;
  }
  if (endpoint === "/responses") {
    return `HTTP ${result.status} did not return a Responses API object`;
  }
  if (endpoint === "/models") {
    return `HTTP ${result.status} did not return a model list`;
  }
  return "";
}

function buildCacheBehaviorReport(cacheSummary) {
  if (!cacheSummary) {
    return {
      tested: false,
      interpretation: "Cache behavior was not tested in this phase.",
    };
  }

  if (cacheSummary.responses || cacheSummary.chatCompletions) {
    const responses = buildEndpointCacheReport(cacheSummary.responses);
    const chatCompletions = buildEndpointCacheReport(cacheSummary.chatCompletions);
    return {
      chatCompletions,
      comparison: cacheSummary.comparison || summarizeCacheComparison(cacheSummary.responses, cacheSummary.chatCompletions),
      matrix: cacheSummary.matrix,
      round: cacheSummary.round,
      responses,
      tested: true,
    };
  }

  return {
    singleEndpoint: buildEndpointCacheReport(cacheSummary),
    tested: true,
  };
}

function buildEndpointCacheReport(summary) {
  if (!summary) {
    return {
      tested: false,
      interpretation: "This cache mode was not tested.",
    };
  }

  const rounds = summary.rounds || [];
  const hitStats = cacheHitStats(rounds);
  const stableAfterWarmup = summary.stableAfterWarmup ?? hitStats.stableAfterWarmup;
  const intermittentHit = summary.intermittentHit ?? hitStats.intermittentHit;
  const stability = summary.stability || hitStats.stability;

  return {
    confirmedByUser: Boolean(summary.confirmedByUser),
    endpoint: summary.endpoint || null,
    hitRate: summary.hitRate || hitStats.hitRate,
    hitRounds: hitStats.hitRounds,
    intermittentHit,
    interpretation: summary.confirmedByUser
      ? rounds.length === 0
        ? `${summary.endpoint || "Mode"} cache strategy was confirmed by the user and locked for this cache run.`
        : intermittentHit
          ? `${summary.endpoint || "Mode"} cache mechanism was confirmed by the user, but hit behavior was intermittent (${summary.hitRate || hitStats.hitRate} later rounds).`
          : `${summary.endpoint || "Mode"} cache strategy was confirmed by the user.`
      : summary.likelyHit
        ? intermittentHit
          ? `${summary.endpoint || "Mode"} cache-read tokens were observed intermittently (${summary.hitRate || hitStats.hitRate} later rounds).`
          : `${summary.endpoint || "Mode"} cache hit observed via cache-read usage fields.`
        : `${summary.endpoint || "Mode"} did not expose later-round cache-read tokens in this run.`,
    likelyHit: Boolean(summary.likelyHit),
    maxCacheReadTokens: hitStats.maxCacheReadTokens,
    mechanism: describeCacheMechanism(summary),
    promptCacheKey: summary.promptCacheKey || null,
    requestIds: rounds.map((round) => round.requestId).filter(Boolean),
    stability,
    stableAfterWarmup,
    strategy: summary.strategy || null,
    tested: true,
  };
}

function describeCacheMechanism(summary) {
  const selectedStrategy = summary?.strategy || "";
  if (selectedStrategy === "plain") {
    return "Responses-shaped request with default previous_response_id chaining.";
  }
  if (selectedStrategy === "prompt-key-session-header") {
    return "prompt_cache_key plus Session_id header with response-ID chaining.";
  }
  if (selectedStrategy === "prompt-key-store-true") {
    return "prompt_cache_key with store:true and response-ID state enabled.";
  }
  if (selectedStrategy === "prompt-key-store-false") {
    return "prompt_cache_key with store:false; tests explicit stateless opt-out behavior.";
  }
  if (selectedStrategy === "implicit-derived-key") {
    return "backend-derived key from stable model, reasoning, tools, system prompt, and first user turn.";
  }
  if (selectedStrategy === "session-header-only") {
    return "Session_id header only, without prompt_cache_key.";
  }
  if (selectedStrategy === "chat-session-header") {
    return "Repeated Chat Completions with a stable Session_id header and stable system prefix.";
  }
  if (selectedStrategy === "chat-session-header-prompt-cache-key") {
    return "Repeated Chat Completions with both a stable Session_id header and top-level prompt_cache_key.";
  }
  if (selectedStrategy === "chat-prompt-cache-key") {
    return "Repeated Chat Completions with a top-level prompt_cache_key and stable system prefix.";
  }
  if (selectedStrategy === "chat-repeat") {
    return "Repeated Chat Completions with only an identical long prefix; tests automatic provider prefix cache.";
  }
  if (selectedStrategy.includes("cache-control")) {
    return "Anthropic-style cache_control blocks sent through an OpenAI-compatible route.";
  }
  return summary?.strategyDescription || "Cache strategy not described.";
}

function buildRecommendations(apiBehavior, cacheBehavior) {
  const recommendations = [];
  if (!baseURL.endsWith("/v1")) {
    recommendations.push("Configure provider pre-detection with the upstream /v1 API base URL. Use cursorProxy /openaicompat/v1 only for the later integration-validation stage.");
  }
  const responseCache = cacheBehavior.responses || cacheBehavior.singleEndpoint;
  const chatCache = cacheBehavior.chatCompletions;
  if (responseCache?.likelyHit) {
    if (responseCache.intermittentHit) {
      recommendations.push(
        `Responses-mode cache was observed intermittently with ${responseCache.mechanism}; rerun the same strategy with a fresh key and more rounds before calling it stable.`,
      );
    } else {
      recommendations.push(
        responseCache.confirmedByUser
        ? `Chat-boundary Responses-mode cache was user-confirmed with ${responseCache.mechanism}`
          : `Chat-boundary Responses-mode cache was observed with ${responseCache.mechanism}; verify provider logs before marking it confirmed.`,
      );
    }
  }
  if (chatCache?.tested && !chatCache.likelyHit) {
    recommendations.push("Treat Chat Completions cache as unconfirmed unless provider logs show hits.");
  } else if (chatCache?.likelyHit) {
    recommendations.push(
      chatCache.confirmedByUser
        ? `Chat Completions cache was user-confirmed with ${chatCache.mechanism}`
        : `Chat Completions cache was observed with ${chatCache.mechanism}; verify logs before marking it confirmed.`,
    );
  }
  if (apiBehavior.responses.works && !apiBehavior.chatCompletions.works) {
    recommendations.push("Chat-boundary Responses-mode cache probe works, but baseline Chat Completions was not confirmed in this run.");
  }
  recommendations.push(...buildConfigRecommendations(cacheBehavior));
  return recommendations;
}

function buildConfigRecommendations(cacheBehavior) {
  const recommendations = [];
  const responseStrategy = cacheBehavior.responses?.strategy || cacheBehavior.singleEndpoint?.strategy;
  const chatStrategy = cacheBehavior.chatCompletions?.strategy;

  if (responseStrategy === "plain") {
    recommendations.push(
      "For cursorProxy, keep `OPENAICOMPAT_WIRE_API=responses` with default response-ID chaining when logs confirm `PREV_RESP_ID_FOUND` and `CACHE_OAI_RESP_ID`.",
    );
  }

  if (["prompt-key-session-header", "implicit-derived-key", "prompt-key-store-true", "codex-client-metadata"].includes(responseStrategy)) {
    recommendations.push(
      "For cursorProxy Responses integration, test `OPENAICOMPAT_CACHE_HIT_MODE=sub2api`; it can inject `compat_cc_*` prompt cache keys while preserving response-ID state.",
    );
  }

  if (responseStrategy === "prompt-key-store-false") {
    recommendations.push(
      "`store:false` disables cursorProxy response-ID state; use it only when the privacy/stateless requirement is more important than `previous_response_id` chaining.",
    );
  }

  if (["chat-session-header-prompt-cache-key", "chat-prompt-cache-key"].includes(chatStrategy)) {
    recommendations.push(
      "For cursorProxy Chat integration, test `OPENAICOMPAT_CHAT_CACHE_MODE=remote` when the upstream owns prompt-cache/session routing and should receive a stable `prompt_cache_key`. If the provider also requires an upstream `Session_id` header, verify or add header forwarding.",
    );
  }

  if (chatStrategy === "chat-repeat") {
    recommendations.push(
      "For Chat wire mode with provider-side automatic prefix cache only, keep `OPENAICOMPAT_CHAT_CACHE_MODE` unset unless usage normalization is needed.",
    );
  }

  if (cacheBehavior.chatCompletions?.likelyHit && !chatStrategy?.includes("prompt-cache-key")) {
    recommendations.push(
      "If Chat Completions cache hits only through raw provider usage counters, `OPENAICOMPAT_CHAT_CACHE_MODE=facade` can normalize cached-token accounting without adding remote state hints.",
    );
  }

  return recommendations;
}

function buildProviderSummary(apiBehavior, cacheBehavior) {
  const apiParts = [];
  apiParts.push(apiBehavior.chatCompletions.works ? "Chat Completions works" : "Chat Completions not confirmed");
  apiParts.push(apiBehavior.responses.works ? "Responses mode works" : "Responses mode not confirmed");

  const cacheParts = [];
  if (cacheBehavior.responses) cacheParts.push(cacheStateLabel("Responses mode", cacheBehavior.responses));
  if (cacheBehavior.chatCompletions) cacheParts.push(cacheStateLabel("Chat Completions", cacheBehavior.chatCompletions));
  if (cacheBehavior.singleEndpoint) {
    cacheParts.push(
      cacheBehavior.singleEndpoint.likelyHit
        ? `${cacheBehavior.singleEndpoint.endpoint || "Mode"} cache hit observed`
        : `${cacheBehavior.singleEndpoint.endpoint || "Mode"} cache hit not observed`,
    );
  }
  return [apiParts.join("; "), cacheParts.filter(Boolean).join("; ")].filter(Boolean).join(". ");
}

function cacheStateLabel(label, cacheReport) {
  if (cacheReport.confirmedByUser && cacheReport.intermittentHit) {
    return `${label} cache confirmed but intermittent`;
  }
  if (cacheReport.confirmedByUser) return `${label} cache confirmed`;
  if (cacheReport.likelyHit && cacheReport.intermittentHit) {
    return `${label} cache hit observed intermittently`;
  }
  return cacheReport.likelyHit ? `${label} cache hit observed` : `${label} cache hit not observed`;
}

function summarizeCacheResults(selectedStrategy, results, extra = {}) {
  const rounds = results.map((result) => ({
    cacheSignals: result.cacheSignals,
    cachedTokens: result.cachedTokens,
    diagnosticHeaders: result.diagnosticHeaders,
    durationMs: result.durationMs,
    errorDetail: result.errorDetail,
    object: result.object,
    ok: result.ok,
    requestId: result.requestId,
    responseId: result.responseId,
    status: result.status,
    usage: result.usage,
  }));
  const hitStats = cacheHitStats(rounds);
  const likelyHit = hitStats.laterHitCount > 0;
  const creationSeen = rounds.some((round) => Number(round.cacheSignals?.cacheCreationTokens || 0) > 0);
  const missSeen = rounds.some((round) => Number(round.cacheSignals?.cacheMissTokens || 0) > 0);
  const responseIdsSeen = rounds.filter((round) => round.responseId).length;

  return {
    ...extra,
    creationSeen,
    hitRate: hitStats.hitRate,
    intermittentHit: hitStats.intermittentHit,
    laterHitCount: hitStats.laterHitCount,
    laterRoundCount: hitStats.laterRoundCount,
    likelyHit,
    missSeen,
    stableAfterWarmup: hitStats.stableAfterWarmup,
    stability: hitStats.stability,
    note: cacheSummaryNote({
      creationSeen,
      hitStats,
      likelyHit,
      mode: extra.mode,
      responseIdsSeen,
    }),
    responseIdsSeen,
    rounds,
    strategy: selectedStrategy,
  };
}

function cacheSummaryNote({ creationSeen, hitStats, likelyHit, mode, responseIdsSeen }) {
  if (likelyHit) {
    return hitStats.stableAfterWarmup
      ? "Every later round reported cached tokens after the warm-up request."
      : `Only some later rounds reported cached tokens (${hitStats.hitRate}); treat this as an intermittent hit until a fresh stability round confirms the hit rate.`;
  }
  if (mode === "public-chat-boundary-to-responses" && responseIdsSeen > 0) {
    return "Response IDs were visible, but API usage did not report cached tokens. Verify previous_response_id chaining with PREV_RESP_ID_FOUND and CACHE_OAI_RESP_ID logs; prompt-cache billing still needs dashboard confirmation.";
  }
  if (creationSeen) {
    return "Cache creation/write tokens were reported, but no later round reported cache-read tokens yet. Verify dashboard/logs, then repeat after the provider cache warmup window.";
  }
  return "No later round reported cached tokens. Verify provider dashboard/logs before trying another strategy.";
}

function cacheReadTokens(round) {
  const value = Number(round?.cacheSignals?.cacheReadTokens ?? round?.cachedTokens ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function cacheHitStats(rounds) {
  const classifiedRounds = rounds.map((round, index) => ({
    cachedTokens: cacheReadTokens(round),
    index: index + 1,
    requestId: round.requestId,
  }));
  const hitRounds = classifiedRounds.filter((round) => round.cachedTokens > 0);
  const laterRounds = classifiedRounds.slice(1);
  const laterHitCount = laterRounds.filter((round) => round.cachedTokens > 0).length;
  const laterRoundCount = laterRounds.length;
  const stableAfterWarmup = laterRoundCount > 0 && laterHitCount === laterRoundCount;
  const intermittentHit = laterHitCount > 0 && !stableAfterWarmup;
  const stability =
    laterRoundCount === 0
      ? "not-measured"
      : stableAfterWarmup
        ? "stable-after-warmup"
        : intermittentHit
          ? "intermittent"
          : "not-observed";

  return {
    hitRate: `${laterHitCount}/${laterRoundCount}`,
    hitRounds,
    intermittentHit,
    laterHitCount,
    laterRoundCount,
    maxCacheReadTokens: hitRounds.reduce((max, round) => Math.max(max, round.cachedTokens), 0),
    stability,
    stableAfterWarmup,
  };
}

function summarizeCacheComparison(responseSummary, chatSummary) {
  const responsesLikelyHit = Boolean(responseSummary?.likelyHit);
  const chatCompletionsLikelyHit = Boolean(chatSummary?.likelyHit);
  const responsesConfirmed = Boolean(responseSummary?.confirmedByUser);
  const chatCompletionsConfirmed = Boolean(chatSummary?.confirmedByUser);
  const responseHitText = responseSummary?.intermittentHit
    ? "Responses mode reported intermittent cache-read tokens"
    : "Responses mode reported cache-read tokens";
  const chatHitText = chatSummary?.intermittentHit
    ? "Chat Completions reported intermittent cache-read tokens"
    : "Chat Completions reported cache-read tokens";
  let conclusion = "Neither mode reported later-round cache-read tokens.";
  if (responsesConfirmed && chatCompletionsConfirmed) {
    conclusion = "Both Responses mode and Chat Completions have user-confirmed cache strategies.";
  } else if (responsesConfirmed && chatCompletionsLikelyHit) {
    conclusion = `Responses mode is user-confirmed; ${chatHitText} in this run.`;
  } else if (responsesConfirmed) {
    conclusion = "Responses mode is user-confirmed; Chat Completions did not report cache-read tokens in this run.";
  } else if (chatCompletionsConfirmed && responsesLikelyHit) {
    conclusion = `Chat Completions is user-confirmed; ${responseHitText} in this run.`;
  } else if (chatCompletionsConfirmed) {
    conclusion = "Chat Completions is user-confirmed; Responses mode did not report cache-read tokens in this run.";
  } else if (responsesLikelyHit && chatCompletionsLikelyHit) {
    conclusion = `${responseHitText}; ${chatHitText}.`;
  } else if (responsesLikelyHit) {
    conclusion = `${responseHitText}; Chat Completions did not in this run.`;
  } else if (chatCompletionsLikelyHit) {
    conclusion = `${chatHitText}; Responses mode did not in this run.`;
  }

  return {
    chatCompletionsLikelyHit,
    conclusion,
    responsesLikelyHit,
  };
}

function bestCacheSummary(summaries) {
  const usable = summaries.filter(Boolean);
  if (usable.length === 0) return null;
  const hits = usable.filter((summary) => summary.likelyHit);
  if (hits.length > 0) {
    return hits.sort((a, b) => maxCacheReadTokens(b) - maxCacheReadTokens(a))[0];
  }
  return usable[0];
}

function maxCacheReadTokens(summary) {
  return (summary?.rounds || []).reduce((max, round) => {
    const value = cacheReadTokens(round);
    return Math.max(max, value);
  }, 0);
}

function confirmedCacheSummary(endpoint, strategy) {
  return {
    confirmedByUser: true,
    endpoint,
    likelyHit: true,
    note:
      "User confirmed this cache mechanism in provider logs; it was locked while probing the other mode.",
    rounds: [],
    strategy,
  };
}

function summarizeCacheRound({
  chatStrategy,
  confirmedChatStrategy,
  confirmedResponseStrategy,
  endpointScope,
  responseStrategy,
  testChat,
  testResponses,
}) {
  const nextAction = testResponses
    ? "Stop after this Responses round. Ask the user to verify the listed request IDs in provider logs. If not confirmed, keep testing the next Responses strategy; do not start Chat Completions until Responses is confirmed or exhausted."
    : testChat
      ? "Stop after this Chat Completions round. Ask the user to verify the listed request IDs in provider logs. If not confirmed, keep testing the next Chat strategy."
      : "No unconfirmed cache family was tested in this round.";
  return {
    bounded: true,
    chatCompletions: {
      confirmedStrategy: confirmedChatStrategy || null,
      locked: Boolean(confirmedChatStrategy),
      testedStrategy: testChat ? chatStrategy : null,
    },
    endpointScope,
    nextAction,
    responses: {
      confirmedStrategy: confirmedResponseStrategy || null,
      locked: Boolean(confirmedResponseStrategy),
      testedStrategy: testResponses ? responseStrategy : null,
    },
    userConfirmationRequired: Boolean(testChat || testResponses),
  };
}

function summarizeCacheMatrix({
  chatStrategies,
  chatSummaries,
  confirmedChatStrategy,
  confirmedResponseStrategy,
  endpointScope,
  includeLateStrategies,
  responseStrategies,
  responseSummaries,
  testChat,
  testResponses,
}) {
  const responseHits = responseSummaries.filter((summary) => summary?.likelyHit);
  const chatHits = chatSummaries.filter((summary) => summary?.likelyHit);
  const nextAction = testResponses
    ? "Pause for provider-log confirmation of the Responses matrix. If no strategy is confirmed, continue Responses strategies before starting Chat Completions."
    : testChat
      ? "Pause for provider-log confirmation of the Chat Completions matrix. If no strategy is confirmed, continue Chat strategies."
      : "No unconfirmed cache family was tested in this matrix.";

  return {
    chatCompletions: {
      confirmedStrategy: confirmedChatStrategy || null,
      exhausted: Boolean(testChat && chatSummaries.length === chatStrategies.length && chatHits.length === 0),
      hitStrategies: cacheMatrixEntries(chatHits),
      locked: Boolean(confirmedChatStrategy),
      testedStrategies: chatSummaries.map((summary) => summary.strategy),
    },
    endpointScope,
    includeLateStrategies,
    nextAction,
    responses: {
      confirmedStrategy: confirmedResponseStrategy || null,
      exhausted: Boolean(
        testResponses && responseSummaries.length === responseStrategies.length && responseHits.length === 0,
      ),
      hitStrategies: cacheMatrixEntries(responseHits),
      locked: Boolean(confirmedResponseStrategy),
      testedStrategies: responseSummaries.map((summary) => summary.strategy),
    },
    strategyCatalog: {
      chatCompletions: chatStrategies,
      responses: responseStrategies,
    },
  };
}

function cacheMatrixEntries(summaries) {
  return summaries.map((summary) => ({
    hitRate: summary.hitRate,
    intermittentHit: Boolean(summary.intermittentHit),
    maxCacheReadTokens: maxCacheReadTokens(summary),
    requestIds: (summary.rounds || []).map((round) => round.requestId).filter(Boolean),
    stability: summary.stability || null,
    stableAfterWarmup: Boolean(summary.stableAfterWarmup),
    strategy: summary.strategy,
  }));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function responseChainStrategy(selectedStrategy) {
  const configs = {
    "cache-control-content-blocks": {
      cacheControlBlocks: true,
      description: "Public Chat request with Anthropic-style cache_control content blocks. Use only for OpenAI facades that are known to accept Anthropic cache hints.",
      headers: {},
      includePromptCacheKey: true,
      reasoningEffort: "low",
      store: true,
    },
    "codex-client-metadata": {
      clientMetadata: { "x-codex-window-id": "{cacheKey}" },
      description: "Public Chat request with prompt_cache_key plus client_metadata.x-codex-window-id for Codex/CLIProxy-style replay session keys.",
      headers: { Session_id: "{cacheKey}" },
      includePromptCacheKey: true,
      reasoningEffort: "low",
      store: true,
    },
    "implicit-derived-key": {
      description: "Public Chat request without explicit prompt_cache_key. Tests backend-derived cache keys for GPT-5/Codex-like models.",
      headers: {},
      includePromptCacheKey: false,
      reasoningEffort: "low",
      store: true,
    },
    "plain": {
      description: "Public Chat request with no explicit cache hints. Tests default Responses previous_response_id chaining only.",
      headers: {},
      includePromptCacheKey: false,
      reasoningEffort: "low",
      store: true,
    },
    "prompt-key-session-header": {
      description: "Public Chat request with prompt_cache_key and Session_id. Tests CLIProxy/sub2api-style cache routing hints plus response-ID chaining.",
      headers: { Session_id: "{cacheKey}" },
      includePromptCacheKey: true,
      reasoningEffort: "low",
      store: true,
    },
    "prompt-key-store-false": {
      description: "Public Chat request with prompt_cache_key and store:false. Tests explicit stateless opt-out behavior.",
      headers: {},
      includePromptCacheKey: true,
      reasoningEffort: "low",
      store: false,
    },
    "prompt-key-store-true": {
      description: "Public Chat request with prompt_cache_key and store:true. Tests prompt-cache routing hints while keeping response-ID state enabled.",
      headers: {},
      includePromptCacheKey: true,
      reasoningEffort: "low",
      store: true,
    },
    "session-header-only": {
      description: "Public Chat request with Session_id header only. Tests gateways that key cache behavior from headers.",
      headers: { Session_id: "{cacheKey}" },
      includePromptCacheKey: false,
      reasoningEffort: "low",
      store: true,
    },
  };
  const config = configs[selectedStrategy];
  if (!config) throw new Error(`Unknown responses-chain --strategy ${selectedStrategy}`);
  return config;
}

function chatCacheStrategy(selectedStrategy) {
  const configs = {
    "chat-cache-control-content": {
      cacheControlBlocks: true,
      description: "Chat Completions repeat with Anthropic-style cache_control text blocks. Strict OpenAI-compatible gateways may reject this.",
      headers: {},
      includePromptCacheKey: false,
    },
    "chat-prompt-cache-key": {
      description: "Chat Completions repeat with top-level prompt_cache_key.",
      headers: {},
      includePromptCacheKey: true,
    },
    "chat-session-header-prompt-cache-key": {
      description: "Chat Completions repeat with both Session_id and top-level prompt_cache_key. Tests gateways that require both cache routing signals together.",
      headers: { Session_id: "{cacheKey}" },
      includePromptCacheKey: true,
    },
    "chat-repeat": {
      description: "Plain repeated Chat Completions request with a long stable system prefix.",
      headers: {},
      includePromptCacheKey: false,
    },
    "chat-session-header": {
      description: "Repeated Chat Completions request with stable Session_id header.",
      headers: { Session_id: "{cacheKey}" },
      includePromptCacheKey: false,
    },
  };
  const config = configs[selectedStrategy];
  if (!config) throw new Error(`Unknown chat-cache --strategy ${selectedStrategy}`);
  return config;
}

function upstreamResponseStrategy(selectedStrategy, promptCacheKey) {
  const configs = {
    "plain": {
      description: "Direct upstream Responses request with previous_response_id and no prompt-cache hints.",
      headers: {},
      includePromptCacheKey: false,
    },
    "prompt-key-session-header": {
      description: "Direct upstream Responses request with prompt_cache_key and Session_id.",
      headers: { Session_id: promptCacheKey },
      includePromptCacheKey: true,
    },
    "prompt-key-store-true": {
      description: "Direct upstream Responses request with prompt_cache_key and store:true.",
      headers: {},
      includePromptCacheKey: true,
    },
  };
  const config = configs[selectedStrategy] || configs.plain;
  return config;
}

function chatCacheMessages(round, options = {}) {
  return [
    chatMessage("system", longStablePrefix(), options),
    chatMessage("user", `OpenAI-compatible Chat cache probe round ${round + 1}. Say exactly: ok`, options),
  ];
}

function upstreamResponseInput(round) {
  const input = [
    { content: longStablePrefix(), role: "developer" },
    { content: "Stable first user turn for direct upstream Responses probing. Answer with ok when asked.", role: "user" },
  ];
  if (round > 0) input.push({ content: "ok", role: "assistant" });
  input.push({ content: `Direct upstream Responses probe round ${round + 1}. Say exactly: ok`, role: "user" });
  return input;
}

function chatMessage(role, text, options = {}) {
  if (!options.cacheControlBlocks) return { content: text, role };
  return {
    content: [
      {
        cache_control: { type: "ephemeral" },
        text,
        type: "text",
      },
    ],
    role,
  };
}

function longStablePrefix() {
  const repeats = numberArg(args.prefixRepeats, 120);
  const line = "Stable OpenAI-compatible cache probe instruction: preserve this prefix exactly so provider-side prompt caching can match it.";
  return Array.from({ length: repeats }, (_, index) => `${index + 1}. ${line}`).join("\n");
}

function baseUrlAdvice(value) {
  if (!value) return "Missing base URL.";
  if (/\/openaicompat\/v1$/i.test(value)) return "Base URL uses the cursorProxy openaicompat route; use this for integration validation, not direct upstream pre-detection.";
  if (/\/v1$/i.test(value)) return "Base URL ends in /v1. Use a provider-native model ID for upstream pre-detection.";
  return "Base URL does not end with /v1. OpenAI-compatible API bases normally end in /v1.";
}

function runtimeExpectation(value, selectedModel) {
  const expectedWireApi = args.expectedWireApi || process.env.OPENAICOMPAT_WIRE_API || "unknown";
  const chatCacheMode = args.expectedChatCacheMode || process.env.OPENAICOMPAT_CHAT_CACHE_MODE || "unknown";
  const cacheHitMode = args.expectedCacheHitMode || process.env.OPENAICOMPAT_CACHE_HIT_MODE || "unknown";
  const explicitOpenAICompat = /\/openaicompat\/v1$/i.test(value);
  return {
    cacheHitMode,
    chatCacheMode,
    expectedWireApi,
    explicitOpenAICompatRoute: explicitOpenAICompat,
    note: explicitOpenAICompat
      ? "Requests target cursorProxy provider=openaicompat directly."
      : "Requests target the configured /v1 API base. Use provider-native model IDs for upstream pre-detection.",
    publicPathUnderTest: "/chat/completions",
    selectedModel,
  };
}

function defaultStrategyForPhase(selectedPhase) {
  if (selectedPhase === "responses-chain") return "plain";
  if (selectedPhase === "chat-cache") return "chat-session-header-prompt-cache-key";
  if (selectedPhase === "cache-round") return "";
  if (selectedPhase === "cache-matrix") return "";
  if (selectedPhase === "upstream-responses") return "plain";
  return "";
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function normalizeArgAliases(parsed) {
  const aliases = {
    "api-key": "apiKey",
    "base-url": "baseURL",
    "cache-key": "cacheKey",
    "chat-strategies": "chatStrategies",
    "chat-strategy": "chatStrategy",
    "confirmed-chat-strategy": "confirmedChatStrategy",
    "confirmed-response-strategy": "confirmedResponseStrategy",
    "endpoint-scope": "endpoint",
    "expected-cache-hit-mode": "expectedCacheHitMode",
    "expected-chat-cache-mode": "expectedChatCacheMode",
    "expected-wire-api": "expectedWireApi",
    "include-late-strategies": "includeLateStrategies",
    "include-usage": "includeUsage",
    "matrix-endpoint": "matrixEndpoint",
    "matrix-mode": "matrixMode",
    "pause-ms": "pauseMs",
    "prefix-repeats": "prefixRepeats",
    "response-strategies": "responseStrategies",
    "response-strategy": "responseStrategy",
    "timeout-ms": "timeoutMs",
    "upstream-api-key": "upstreamApiKey",
    "upstream-base-url": "upstreamBaseURL",
    "upstream-model": "upstreamModel",
  };
  for (const [from, to] of Object.entries(aliases)) {
    if (parsed[from] !== undefined && parsed[to] === undefined) parsed[to] = parsed[from];
  }
}

function parseListArg(value, fallback) {
  if (!value || value === true) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringArg(value) {
  if (!value || value === true) return "";
  return String(value).trim();
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function numberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function joinUrl(root, path) {
  return `${trimTrailingSlash(root)}${path.startsWith("/") ? path : `/${path}`}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultCacheKey(kind) {
  return `cursorproxy_probe_${kind}_${sha256(`${baseURL}|${model}|${kind}|${probeNonce}`).slice(0, 24)}`;
}

function cacheBothKey(scope) {
  return args.cacheKey ? `${args.cacheKey}_${scope}` : defaultCacheKey(scope);
}

function hydrateCacheKey(value, cacheKey) {
  if (typeof value === "string") return value === "{cacheKey}" ? cacheKey : value;
  if (Array.isArray(value)) return value.map((item) => hydrateCacheKey(item, cacheKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hydrateCacheKey(item, cacheKey)]),
    );
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(value, max = 600) {
  const secrets = [
    apiKey,
    process.env.PROBE_OPENAICOMPATIBLE_API_KEY || "",
    process.env.PROBE_OPENAICOMPATIBLE_UPSTREAM_API_KEY || "",
    args.upstreamApiKey || "",
  ].filter(Boolean);
  let clean = String(value || "");
  for (const secret of secrets) {
    clean = clean.replaceAll(secret, "[REDACTED_API_KEY]");
  }
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

