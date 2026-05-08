function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function extractProxySecret(req) {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const xk = req.headers.get("x-api-key");
  if (xk) return xk.trim();
  return null;
}

export function jsonErrorResponse(status, message, code, type = "invalid_request_error") {
  return new Response(
    JSON.stringify({
      error: { message, type, code },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

export function cleanEnvValue(name) {
  return (process.env[name] || "").trim().replace(/^["']|["']$/g, "");
}

export function allowedEnvValue(name, allowed) {
  const value = cleanEnvValue(name);
  return allowed.has(value) ? value : null;
}

/** If CURSORPROXY_API_KEY is set, require Bearer or x-api-key match. */
export function checkProxyAuth(req) {
  const required = cleanEnvValue("CURSORPROXY_API_KEY");
  if (!required) return null;
  const secret = extractProxySecret(req);
  if (!secret || !timingSafeEqualStr(secret, required)) {
    return jsonErrorResponse(
      401,
      "Incorrect API key provided.",
      "invalid_api_key",
      "invalid_request_error"
    );
  }
  return null;
}
