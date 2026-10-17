export function isMiniMaxM31(model) {
  return String(model || "").toLowerCase() === "minimax-m3.1-flash-preview";
}

// Legacy M2/M3 request policy remains unchanged. M3.1 is always adaptive.
export function sanitizeMiniMaxBody(body) {
  if (isMiniMaxM31(body.model)) {
    if (body.thinking != null && body.thinking.type !== "adaptive") {
      return "MiniMax-M3.1-Flash-Preview requires adaptive thinking.";
    }
    if (body.reasoning_effort != null && !["low", "medium", "high", "xhigh", "max"].includes(body.reasoning_effort)) {
      return "MiniMax-M3.1-Flash-Preview reasoning_effort must be low, medium, high, xhigh, or max.";
    }
    if (body.reasoning_split === false) return "MiniMax-M3.1-Flash-Preview requires reasoning_split: true.";
    body.reasoning_effort ??= "max";
  }
  body.reasoning_split = true;
  if (String(body.model || "").toLowerCase().startsWith("minimax-m3") && !body.thinking) {
    body.thinking = { type: "adaptive" };
  }
  return null;
}
