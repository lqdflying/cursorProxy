// EdgeOne Pages Cloud Function: legacy /deepseek/v1/* path.

import { handleProxyRequest } from "../../_shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, "deepseek");
}
