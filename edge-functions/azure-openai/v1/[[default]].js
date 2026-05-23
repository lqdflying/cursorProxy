// EdgeOne Pages Edge Function: legacy /azure-openai/v1/* path.

import { handleProxyRequest } from "../../_shared/proxy.js";

export function onRequest(context) {
  return handleProxyRequest(context, "azureopenai");
}

export default onRequest;
