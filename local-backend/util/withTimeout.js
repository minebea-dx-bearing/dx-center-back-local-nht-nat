/**
 * Reject after `ms` instead of waiting forever. `ms = 0` disables it entirely.
 *
 * The underlying work is NOT cancelled — node cannot — but the caller stops
 * waiting on it. That distinction is the whole value: the caches in this
 * codebase all park an `inflight` promise so a burst of viewers triggers one
 * build, and a source that HANGS rather than rejects leaves that promise
 * pending forever. Every later request then joins the same dead promise and the
 * endpoint stays down until restart. The `.catch` guards around those caches
 * only fire on rejection, which a hang never produces — this is what turns one
 * into the other.
 *
 * Lives in its own file rather than beside either caller: masterStorage needs
 * it too, and a storage layer importing a route builder to get it would be the
 * wrong dependency direction.
 */
const withTimeout = (promise, ms, label) => {
  if (!ms) return promise;

  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

module.exports = { withTimeout };
