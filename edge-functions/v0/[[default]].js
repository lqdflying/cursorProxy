// EdgeOne Pages Edge Function: unified /v0/* path (model-based routing).

import { handleProxyRequest } from "../_shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, null);
}

export default onRequest;
