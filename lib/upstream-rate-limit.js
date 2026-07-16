const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_JITTER_MS = 250;

function parseRetryAfter(retryAfterValue, nowMs = Date.now()) {
  const value = String(retryAfterValue || "").trim();
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return {
      delayMs: seconds * 1_000,
      source: "retry-after-seconds",
    };
  }

  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) return null;
  return {
    delayMs: Math.max(0, retryAtMs - nowMs),
    source: "retry-after-date",
  };
}

export function upstreamRateLimitRetryDelay(
  retryAfterValue,
  {
    nowMs = Date.now(),
    randomValue = Math.random(),
  } = {},
) {
  const parsedRetryAfter = parseRetryAfter(retryAfterValue, nowMs);
  const baseDelayMs = parsedRetryAfter?.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  const boundedRandomValue = Math.max(0, Math.min(1, Number(randomValue) || 0));
  const jitterMs = Math.floor(boundedRandomValue * MAX_JITTER_MS);

  return {
    delayMs: Math.min(MAX_RETRY_DELAY_MS, Math.ceil(baseDelayMs) + jitterMs),
    source: parsedRetryAfter?.source || "fallback",
  };
}

export function waitForRateLimitRetry(delayMs, requestSignal) {
  if (requestSignal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (completedWait) => {
      if (settled) return;
      settled = true;
      requestSignal?.removeEventListener("abort", abortWait);
      resolve(completedWait);
    };
    const abortWait = () => {
      clearTimeout(timer);
      finish(false);
    };
    const timer = setTimeout(() => finish(true), Math.max(0, delayMs));
    requestSignal?.addEventListener("abort", abortWait, { once: true });
  });
}

export function upstreamRateLimitResponseHeaders(upstreamHeaders) {
  const responseHeaders = new Headers();
  if (!upstreamHeaders) return responseHeaders;

  const contentType = upstreamHeaders.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);

  const retryAfter = upstreamHeaders.get("retry-after");
  if (retryAfter) responseHeaders.set("retry-after", retryAfter);

  const requestId = upstreamHeaders.get("x-request-id");
  if (requestId) responseHeaders.set("x-request-id", requestId);

  upstreamHeaders.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-ratelimit-")) {
      responseHeaders.set(name, value);
    }
  });
  return responseHeaders;
}
