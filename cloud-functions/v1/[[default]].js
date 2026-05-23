// EdgeOne Pages Cloud Function: unified /v1/* path (model-based routing).

import { handleProxyRequest } from "../shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, null);
}
