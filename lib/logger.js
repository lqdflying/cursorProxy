const DEBUG = process.env.DEBUG === "true";

export function createLogger(moduleTag) {
  const prefix = `[cursorProxy:${moduleTag}]`;

  function log(...args) {
    if (DEBUG) console.log(prefix, ...args);
  }

  function diag(...args) {
    console.log(prefix, ...args);
  }

  return { log, diag };
}
