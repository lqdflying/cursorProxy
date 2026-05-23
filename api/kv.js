// ─── KV abstraction ──────────────────────────────────────────────────────────
// Supports three backends:
//   1. Local Redis (Docker)  — server.js injects an ioredis client via setKvDriver()
//   2. Upstash REST (Vercel) — set KV_URL + KV_TOKEN environment variables
//   3. EdgeOne Pages KV       — Cloud Function namespace binding (configurable via
//                               EDGEONE_KV_BINDING env var, default cursorproxy_kv)
//
// proxy.js never imports ioredis directly, so it stays safe for Vercel Edge Runtime.

let _driver = null; // { get(key): Promise<string|null>, set(key, value, "EX", ttl): Promise<void> }
let _edgeoneKv = null; // EdgeOne Pages KV namespace binding
let _noBackendWarningLogged = false;

function diag(...args) {
  console.log("[cursorProxy:kv]", ...args);
}

// Cap error-body previews so a multi-MB upstream error response can't bloat logs.
const ERROR_PREVIEW_MAX = 240;

async function responsePreview(res) {
  const text = await res.text().catch(() => "");
  if (!text) return "(empty)";
  return text.length > ERROR_PREVIEW_MAX
    ? text.slice(0, ERROR_PREVIEW_MAX) + "…(truncated)"
    : text;
}

// Upstash REST fetch timeout (ms). Defaults to UPSTREAM_CONNECT_TIMEOUT_MS so the
// KV path inherits the same hang-protection budget as the model-provider fetch.
// Set to 0 to disable. Without this, a stalled Upstash region can exhaust the
// Vercel Edge 25s pre-stream budget before the model call even starts.
function kvFetchTimeoutMs() {
  const explicit = parseInt(process.env.KV_FETCH_TIMEOUT_MS || "", 10);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const inherited = parseInt(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || "", 10);
  if (Number.isFinite(inherited) && inherited >= 0) return inherited;
  return 8000;
}

// Run an Upstash REST call under a single AbortController whose timer covers
// BOTH the connect phase AND the body read. The previous version cleared the
// timer as soon as fetch() returned headers, which left res.json() free to
// hang indefinitely on a stalled body. The caller passes a `consume` callback
// that does whatever it needs with the response (text, json, .ok check) — the
// signal and timer remain live for that entire call.
async function fetchWithTimeout(url, init, label, consume) {
  const timeoutMs = kvFetchTimeoutMs();
  if (timeoutMs <= 0) {
    const res = await fetch(url, init);
    return consume(res);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await consume(res);
  } catch (err) {
    if (err?.name === "AbortError") {
      const wrapped = new Error(`${label} timed out after ${timeoutMs}ms`);
      wrapped.name = "KvTimeoutError";
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function setKvDriver(driver) {
  _driver = driver;
}

// Register the EdgeOne Pages KV namespace binding from an EdgeOne function context.
// Called by the EdgeOne runtime wrappers before delegating to the handler.
export function setEdgeOneKvBinding(binding) {
  _edgeoneKv = binding;
  // A binding was provided after the lazy resolver may have already cached
  // "no backend" — reset so the next call re-detects with the new binding.
  _eoKvBinding = undefined;
  _noBackendWarningLogged = false;
  diag("KV binding registered (EdgeOne)");
}

// ─── EdgeOne Pages KV key sanitization ───────────────────────────────────
// EdgeOne Pages KV only allows [a-zA-Z0-9_] in keys. Current keys use ':'
// as a prefix separator (conv:..., img:...). Replace ':' with '_' for EdgeOne.
function sanitizeKeyForEdgeOne(key) {
  return key.replace(/:/g, "_");
}

// ─── EdgeOne KV detection (cached) ───────────────────────────────────────
// Lazy-resolves once, then returns the same result for the process lifetime.
// Null means "not available on this platform"; a non-null result is the KV binding.
let _eoKvBinding = undefined; // undefined = not yet resolved, null = unavailable, or binding object

export function resolveEdgeOneKv() {
  if (_eoKvBinding !== undefined) return _eoKvBinding;  // already resolved

  if (_driver) return (_eoKvBinding = null);             // Docker Redis takes priority
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (url && token) return (_eoKvBinding = null);        // Upstash REST takes priority
  if (_edgeoneKv) {
    _eoKvBinding = _edgeoneKv;
    diag("KV found (edgeone, registered binding)");
    return _eoKvBinding;
  }

  // Auto-detect: check global scope for the configured binding variable name
  const name = process.env.EDGEONE_KV_BINDING || "cursorproxy_kv";
  try {
    if (typeof globalThis !== "undefined" && globalThis[name] != null) {
      _eoKvBinding = globalThis[name];
      diag("KV found (edgeone, auto-detected binding:", name + ")");
      return _eoKvBinding;
    }
  } catch { /* globalThis unavailable (rare) */ }

  _eoKvBinding = null;
  diag("KV unavailable (no Redis, Upstash, or EdgeOne KV binding found)");
  return _eoKvBinding;
}

// Returns one of: "redis" | "upstash" | "edgeone" | null
function resolveBackend() {
  if (_driver) return "redis";
  if (process.env.KV_URL && process.env.KV_TOKEN) return "upstash";
  if (resolveEdgeOneKv()) return "edgeone";
  return null;
}

// Public health probe: returns { backend, available, detail }.
// Server bootstrap / health endpoints can call this once at startup to surface
// a missing KV configuration BEFORE cache-dependent features start no-oping.
export function kvBackendStatus() {
  const backend = resolveBackend();
  return {
    backend,
    available: backend !== null,
    detail: backend === null
      ? "No KV backend configured. Reasoning bridge, Azure response-id chaining, and image-description caching will silently degrade. Configure REDIS_URL (Docker), KV_URL+KV_TOKEN (Vercel/Upstash), or an EdgeOne Pages KV namespace."
      : `Using ${backend} backend.`,
  };
}

// Emit a single loud warning the first time a KV op runs with no backend.
// Throttled to once-per-process so we don't drown logs in a hot path.
function warnIfNoBackend() {
  if (_noBackendWarningLogged) return;
  if (resolveBackend() !== null) return;
  _noBackendWarningLogged = true;
  const status = kvBackendStatus();
  diag("NO_BACKEND_CONFIGURED", status.detail);
}

// kvGet returns the cached value or null. A null return means EITHER cache
// miss OR transient backend failure — callers can rely on diag() error logs
// (always-on) for the latter. We do not throw because every caller is already
// in a "fall through to stateless mode" branch on miss.
export async function kvGet(key) {
  warnIfNoBackend();
  if (_driver) {
    try { return await _driver.get(key); } catch (err) { diag("GET_ERROR", "driver", err?.message); return null; }
  }
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (url && token) {
    try {
      return await fetchWithTimeout(
        `${url}/get/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${token}` } },
        "upstash GET",
        async (res) => {
          if (!res.ok) {
            diag("GET_ERROR", "upstash", "status:", res.status, "key:", key, "body:", await responsePreview(res));
            return null;
          }
          const json = await res.json();
          return json.result ?? null;
        },
      );
    } catch (err) {
      diag("GET_ERROR", "upstash", err?.message);
      return null;
    }
  }

  // EdgeOne Pages KV backend (native TTL via expirationTtl; backward-compat with old
  // manually-wrapped {v, e} values that may still be in the store from prior deploys)
  const eoKv = resolveEdgeOneKv();
  if (eoKv) {
    try {
      const safeKey = sanitizeKeyForEdgeOne(key);
      const raw = await eoKv.get(safeKey, { type: "text" });
      if (!raw) return null;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return raw; }
      if (parsed && typeof parsed === "object" && typeof parsed.v !== "undefined") {
        // Old format: manually-wrapped {v: value, e: expiry_ms} — still honour expiry
        if (typeof parsed.e === "number" && Date.now() > parsed.e) {
          eoKv.delete(safeKey).catch((err) => diag("DELETE_ERROR", "edgeone", err?.message));
          return null;
        }
        return parsed.v;
      }
      return raw;
    } catch (err) {
      diag("GET_ERROR", "edgeone", err?.message);
      return null;
    }
  }

  return null;
}

// Default TTL applies when callers don't pass an explicit ttlSeconds. Response
// IDs and reasoning use the same default by design (they expire together with
// the model's server-side memory); image descriptions get a longer TTL since
// they're content-addressed and effectively immutable.
function defaultTtlSeconds() {
  const raw = parseInt(process.env.KV_TTL_SECONDS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7200;
}

function imageTtlSeconds() {
  const raw = parseInt(process.env.KV_IMAGE_TTL_SECONDS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  // Default to 7 days for image-description cache: images are content-addressed
  // by SHA-256 of the data URI, so the same image always hashes to the same key
  // and the description is effectively immutable. No reason to re-pay the
  // vision-API cost every 2 hours.
  return 7 * 24 * 3600;
}

// Derive a sensible TTL from the key prefix when the caller didn't specify one.
// "img:" -> image cache (long TTL). Everything else uses the conversation default.
function pickTtlForKey(key) {
  if (typeof key === "string" && key.startsWith("img:")) return imageTtlSeconds();
  return defaultTtlSeconds();
}

export async function kvSet(key, value, ttlSeconds) {
  warnIfNoBackend();
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds
    : pickTtlForKey(key);
  if (_driver) {
    try { await _driver.set(key, value, "EX", ttl); } catch (err) { diag("SET_ERROR", "driver", err?.message); }
    return;
  }
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (url && token) {
    try {
      await fetchWithTimeout(
        `${url}/set/${encodeURIComponent(key)}?EX=${ttl}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "text/plain",
          },
          body: String(value),
        },
        "upstash SET",
        async (res) => {
          if (!res.ok) {
            diag("SET_ERROR", "upstash", "status:", res.status, "key:", key, "body:", await responsePreview(res));
          }
        },
      );
    } catch (err) { diag("SET_ERROR", "upstash", err?.message); }
    return;
  }

  // EdgeOne Pages KV backend — native TTL via expirationTtl option (seconds)
  const eoKv = resolveEdgeOneKv();
  if (eoKv) {
    try {
      const safeKey = sanitizeKeyForEdgeOne(key);
      await eoKv.put(safeKey, value, { expirationTtl: ttl });
    } catch (err) { diag("SET_ERROR", "edgeone", err?.message); }
    return;
  }
}
