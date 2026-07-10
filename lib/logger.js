export function createLogger(moduleTag) {
  const prefix = `[cursorProxy:${moduleTag}]`;

  // DEBUG is read at call time (not module load) to match the inline
  // log() in api/proxy.js — platforms and tests may set it after import.
  function log(...args) {
    if (process.env.DEBUG === "true") console.log(prefix, ...args);
  }

  function diag(...args) {
    console.log(prefix, ...args);
  }

  return { log, diag };
}
