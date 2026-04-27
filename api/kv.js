// ─── KV abstraction ──────────────────────────────────────────────────────────
// Supports two backends:
//   1. Local Redis (Docker)  — server.js injects an ioredis client via setKvDriver()
//   2. Upstash REST (Vercel) — set KV_URL + KV_TOKEN environment variables
//
// proxy.js never imports ioredis directly, so it stays safe for Vercel Edge Runtime.

let _driver = null; // { get(key): Promise<string|null>, set(key, value, "EX", ttl): Promise<void> }

export function setKvDriver(driver) {
  _driver = driver;
}

export async function kvGet(key) {
  if (_driver) {
    try { return await _driver.get(key); } catch { return null; }
  }
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    return json.result ?? null;
  } catch {
    return null;
  }
}

function defaultTtlSeconds() {
  const raw = parseInt(process.env.KV_TTL_SECONDS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7200;
}

export async function kvSet(key, value, ttlSeconds) {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : defaultTtlSeconds();
  if (_driver) {
    try { await _driver.set(key, value, "EX", ttl); } catch {}
    return;
  }
  const url = process.env.KV_URL;
  const token = process.env.KV_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(
      `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttl}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {}
}
