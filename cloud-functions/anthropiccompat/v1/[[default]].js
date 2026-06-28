// EdgeOne Pages Cloud Function: /anthropiccompat/v1/* path.

import { handleProxyRequest } from "../../shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, "anthropiccompat");
}
