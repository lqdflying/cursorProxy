// EdgeOne Pages Edge Function: legacy /minimax/v1/* path.

import { handleProxyRequest } from "../../_shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, "minimax");
}

export default onRequest;
