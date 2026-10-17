// Explicit published families: do not assign a future model today's contract.
export function isGpt6(model) {
  return /^(?:gpt-6\.1-sol|gpt-6-(?:astra|sol|luna))(?:-\d{4}-\d{2}-\d{2})?$/i.test(model || "");
}

function isOfficialOpenAI(url) {
  try { return new URL(url).hostname === "api.openai.com"; } catch { return false; }
}

export function normalizeGpt6Effort(model, effort, upstreamUrl) {
  if (!isGpt6(model) || !isOfficialOpenAI(upstreamUrl)) return effort;
  return effort === "minimal" || (effort === "none" && /^gpt-6(?:\.1-sol|-astra)(?:-|$)/i.test(model))
    ? "low" : effort;
}

// Call after env/client effort resolution. Unknown gateways keep their contract.
export function sanitizeGpt6Body(provider, body, model, responses, upstreamUrl) {
  if (!body || !isGpt6(model)) return { changed: false };
  const native = provider === "openaicompat" && isOfficialOpenAI(upstreamUrl);
  if (!native && provider !== "azureopenai") return { changed: false };
  let changed = false;
  let effort = responses ? body.reasoning?.effort : body.reasoning_effort;
  const normalized = native ? normalizeGpt6Effort(model, effort, upstreamUrl) : effort;
  if (normalized !== effort) {
    effort = normalized;
    if (responses) body.reasoning = { ...body.reasoning, effort };
    else body.reasoning_effort = effort;
    changed = true;
  }
  if (effort !== "none") {
    for (const key of ["temperature", "top_p", "top_logprobs", "logprobs"]) {
      if (key in body) { delete body[key]; changed = true; }
    }
    if (responses && Array.isArray(body.include) && body.include.includes("message.output_text.logprobs")) {
      body.include = body.include.filter((v) => v !== "message.output_text.logprobs");
      changed = true;
    }
  }
  if (native && !responses && ((Array.isArray(body.tools) && body.tools.length > 0)
      || (Array.isArray(body.functions) && body.functions.length > 0))) {
    if (/^gpt-6(?:\.1-sol|-astra)(?:-|$)/i.test(model) || effort !== "none") {
      return { changed: false, error: `${model} tool calling with reasoning requires Responses. Set OPENAICOMPAT_WIRE_API=responses.` };
    }
  }
  if (native && "prompt_cache_retention" in body) {
    // Explicit modern options win; migration is verified only on api.openai.com.
    body.prompt_cache_options ??= { ttl: "30m" };
    delete body.prompt_cache_retention;
    changed = true;
  }
  if (native && !responses && "max_tokens" in body) {
    body.max_completion_tokens ??= body.max_tokens;
    delete body.max_tokens;
    changed = true;
  }
  return { changed };
}
