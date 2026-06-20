// EdgeOne Pages Cloud Function: legacy /fireworks/v1/* path.

import { handleProxyRequest } from "../../shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, "fireworks");
}
