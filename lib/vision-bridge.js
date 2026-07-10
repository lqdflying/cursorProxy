import { kvGet, kvSet } from "./kv.js";
import { describeImage } from "./vision.js";
import { createLogger } from "./logger.js";

const { log, diag } = createLogger("vision");

/**
 * Convert image content to text descriptions using the configured vision API.
 * Caches descriptions by image hash in KV to avoid re-processing.
 *
 * @param {Array} messages - The messages array from the request body.
 * @param {Function} sha256ImageHash - image hashing helper
 * @returns {Promise<{messages: Array, convertedCount: number, errors: number}>}
 */
async function convertImagesToText(messages, sha256ImageHash) {
  let convertedCount = 0;
  let errors = 0;

  // Flatten all image_url parts to process them with bounded concurrency
  const replacements = []; // { msgIdx, partIdx, imageUrl }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" && m.role !== "system") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;

    for (let j = 0; j < content.length; j++) {
      const part = content[j];
      if (part?.type !== "image_url") continue;

      const imageUrl = part.image_url?.url;
      if (!imageUrl) continue;

      replacements.push({ msgIdx: i, partIdx: j, imageUrl });
    }
  }

  if (replacements.length === 0) {
    return { messages, convertedCount: 0, errors: 0 };
  }

  if (replacements.length > 1) {
    let totalBytes = 0;
    for (const r of replacements) totalBytes += r.imageUrl.length;
    log("VISION_BATCH", "images:", replacements.length, "totalUriBytes:", totalBytes);
  }

  // Bounded concurrency: vision endpoints (e.g. MiniMax-VL-01) rate-limit on
  // bursts. Cache hits short-circuit before the network call so this only
  // throttles real upstream requests. Override via VISION_CONCURRENCY env.
  const concurrency = (() => {
    const raw = parseInt(process.env.VISION_CONCURRENCY || "", 10);
    if (Number.isFinite(raw) && raw >= 1) return raw;
    return 2;
  })();

  const processOne = async ({ msgIdx, partIdx, imageUrl }) => {
    try {
      const cacheKey = await sha256ImageHash(imageUrl);
      const cached = await kvGet(cacheKey);
      if (cached) {
        return { msgIdx, partIdx, description: cached, fromCache: true };
      }

      const description = await describeImage(imageUrl);
      if (description) {
        await kvSet(cacheKey, description).catch(() => {});
      }
      return { msgIdx, partIdx, description, fromCache: false };
    } catch (err) {
      // Always-on: vision failures must be visible in production so operators
      // notice when a key/quota/oversized payload is breaking multi-image runs.
      diag("VISION_ERROR", err?.message);
      return { msgIdx, partIdx, description: null, error: err?.message };
    }
  };

  const results = new Array(replacements.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, replacements.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= replacements.length) return;
        results[idx] = await processOne(replacements[idx]);
      }
    });
  await Promise.all(workers);

  // Apply replacements to a mutable copy of messages
  const updated = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));

  for (const r of results) {
    const { msgIdx, partIdx, description, error } = r;
    if (description) {
      updated[msgIdx].content[partIdx] = {
        type: "text",
        text: "[Image content: " + description + "]",
      };
      convertedCount++;
      log("VISION_CONVERTED", "msg:", msgIdx, "part:", partIdx, "cached:", r.fromCache);
    } else {
      updated[msgIdx].content[partIdx] = {
        type: "text",
        text: "(image attachment unavailable" + (error ? ": " + error : "") + ")",
      };
      errors++;
    }
  }

  // Merge consecutive text parts and (when no image_url remains) collapse to a
  // single string. DeepSeek / MiniMax M2.x non-vision chat endpoints are not
  // reliable about reading the 2nd+ entry of a multi-part text content array,
  // so leaving N separate {type:"text"} parts for N images causes only the
  // first description to be read by the model. Only touch user/system turns
  // we already rewrote — never assistant history.
  for (let i = 0; i < updated.length; i++) {
    const m = updated[i];
    if (m.role !== "user" && m.role !== "system") continue;
    if (!Array.isArray(m.content)) continue;

    const hasImages = m.content.some((p) => p?.type === "image_url");

    if (!hasImages) {
      const joined = m.content
        .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : ""))
        .filter((s) => typeof s === "string" && s.length > 0)
        .join("\n\n");
      m.content = joined.length > 0 ? joined : "(image attachment unavailable)";
      continue;
    }

    // image_url parts still present (vision-capable provider edge case): at
    // least merge runs of consecutive text parts into one.
    const merged = [];
    for (const p of m.content) {
      const isText = typeof p === "string" || p?.type === "text";
      const last = merged[merged.length - 1];
      if (isText && last && (typeof last === "string" || last.type === "text")) {
        const lastText = typeof last === "string" ? last : last.text;
        const curText = typeof p === "string" ? p : p.text;
        merged[merged.length - 1] = {
          type: "text",
          text: (lastText || "") + "\n\n" + (curText || ""),
        };
      } else {
        merged.push(p);
      }
    }
    m.content = merged;
  }

  return { messages: updated, convertedCount, errors };
}

const MIMO_MULTIMODAL = new Set(["mimo-v2.5", "mimo-v2-omni"]);
const GLM_MULTIMODAL = new Set(["glm-5v-turbo"]);

// Decide whether a provider/model pair needs images pre-described to text
// before forwarding (the provider's chat endpoint rejects inline image_url).
function requiresVisionBridge(providerKey, bareModel) {
  if (providerKey === "deepseek") return true;
  if (providerKey === "minimax") {
    const m = (bareModel || "").toLowerCase();
    if (m.startsWith("minimax-m3")) return false; // M3 is natively multimodal
    return true; // M2.x still needs the bridge
  }
  if (providerKey === "mimo") {
    const m = (bareModel || "").toLowerCase();
    return !MIMO_MULTIMODAL.has(m);
  }
  if (providerKey === "glm") {
    const m = (bareModel || "").toLowerCase();
    return !GLM_MULTIMODAL.has(m);
  }
  return false;
}

export { convertImagesToText, requiresVisionBridge };
