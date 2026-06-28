// EdgeOne Pages Cloud Function: /openaicompat/v1/* path.

import { handleProxyRequest } from "../../shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, "openaicompat");
}
