// EdgeOne Pages Cloud Function: health probe with KV backend visibility.

import { setupEdgeOneCompatibility } from "../api/edgeone.js";
import { kvBackendStatus } from "../api/kv.js";

export function onRequest(context) {
  setupEdgeOneCompatibility(context, { EDGEONE_CLOUD_FUNCTION: "true" });
  const status = kvBackendStatus();
  return new Response(
    JSON.stringify({
      status: "ok",
      kv: {
        backend: status.backend,
        available: status.available,
        detail: status.detail,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
