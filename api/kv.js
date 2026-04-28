// ─── KV abstraction ──────────────────────────────────────────────────────────
// Supports three backends:
//   1. Local Redis (Docker)  — server.js injects an ioredis client via setKvDriver()
//   2. Upstash REST (Vercel) — set KV_URL + KV_TOKEN environment variables
//   3. EdgeOne Pages KV       — global namespace binding (configurable via
//                               EDGEONE_KV_BINDING env var, default cursorproxy_kv)
//
// proxy.js never imports ioredis directly, so it stays safe for Vercel Edge Runtime.

let _driver = null; // { get(key): Promise<string|null>, set(key, value, "EX", ttl): Promise<void> }
let _edgeoneKv = null; // EdgeOne Pages KV namespace binding (global variable)

function diag(...args) {
  console.log("[cursorProxy:kv]", ...args);
}

export function setKvDriver(driver) {
  _driver = driver;
}

// Register the EdgeOne Pages KV namespace binding from edge function context.
// Called by edge-functions/_shared/proxy.js before delegating to the handler.
export function setEdgeOneKvBinding(binding) {
  _edgeoneKv = binding;
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

function resolveEdgeOneKv() {
  if (_eoKvBinding !== undefined) return _eoKvBinding;  // already resolved

  if (_driver) return (_eoKvBinding = null);             // Docker Redis takes priority
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (url && token) return (_eoKvBinding = null);        // Upstash REST takes priority
  if (_edgeoneKv) return (_eoKvBinding = _edgeoneKv);    // Explicitly registered binding

  // Auto-detect: check global scope for the configured binding variable name
  const name = process.env.EDGEONE_KV_BINDING || "cursorproxy_kv";
  try {
    if (typeof globalThis !== "undefined" && globalThis[name] != null) {
      return (_eoKvBinding = globalThis[name]);
    }
  } catch { /* globalThis unavailable (rare) */ }

  return (_eoKvBinding = null);
}

export async function kvGet(key) {
  if (_driver) {
    try { return await _driver.get(key); } catch (err) { diag("GET_ERROR", "driver", err?.message); return null; }
  }
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (url && token) {
    try {
      const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      return json.result ?? null;
    } catch (err) {
      diag("GET_ERROR", "upstash", err?.message);
      return null;
    }
  }

  // EdgeOne Pages KV backend (no native TTL — values wrapped as {v: "...", e: <expiry_ms>})
  const eoKv = resolveEdgeOneKv();
  if (eoKv) {
    try {
      const safeKey = sanitizeKeyForEdgeOne(key);
      const raw = await eoKv.get(safeKey, { type: "text" });
      if (!raw) return null;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return raw; }
      if (parsed && typeof parsed === "object" && typeof parsed.v !== "undefined") {
        if (typeof parsed.e === "number" && Date.now() > parsed.e) {
          eoKv.delete(safeKey).catch(() => {});  // expired — best-effort cleanup
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

function defaultTtlSeconds() {
  const raw = parseInt(process.env.KV_TTL_SECONDS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7200;
}

export async function kvSet(key, value, ttlSeconds) {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : defaultTtlSeconds();
  if (_driver) {
    try { await _driver.set(key, value, "EX", ttl); } catch (err) { diag("SET_ERROR", "driver", err?.message); }
    return;
  }
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (url && token) {
    try {
      await fetch(
        `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttl}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) { diag("SET_ERROR", "upstash", err?.message); }
    return;
  }

  // EdgeOne Pages KV backend — wrap with expiry metadata since EdgeOne KV has no native TTL
  const eoKv = resolveEdgeOneKv();
  if (eoKv) {
    try {
      const safeKey = sanitizeKeyForEdgeOne(key);
      const wrapped = JSON.stringify({ v: value, e: Date.now() + ttl * 1000 });
      await eoKv.put(safeKey, wrapped);
    } catch (err) { diag("SET_ERROR", "edgeone", err?.message); }
    return;
  }
}
