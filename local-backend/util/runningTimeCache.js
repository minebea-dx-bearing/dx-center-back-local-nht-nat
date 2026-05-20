/**
 * TTL cache with single-flight coalescing for `queryCurrentRunningTime`-style
 * loaders. Eliminates duplicate concurrent queries (thundering herd) and busts
 * automatically when the shift-day key changes (e.g. at 07:00 for 2GD).
 *
 * Usage:
 *   const cache = createRunningTimeCache({
 *     ttlMs: 20_000,
 *     keyFn: () => `2GD-${shiftStartDate(moment(), 7)}`,
 *     loader: async () => {
 *       const result = await dbms.query(`...`);
 *       return result[1] > 0 ? result[0] : [];
 *     },
 *   });
 *   const rows = await cache.get();
 *
 * - Multiple callers during a cache miss share one in-flight Promise.
 * - On loader rejection, the in-flight Promise is dropped so the next call retries.
 * - When keyFn() output changes (new shift day), the old cached entry is bypassed.
 */

const createRunningTimeCache = ({ ttlMs, keyFn, loader }) => {
  let state = { key: null, at: 0, data: null, inflight: null }; // * state holds the current cache key, timestamp of when it was loaded, the cached data, and any in-flight Promise for a load that's currently happening

  const get = () => {
    const key = keyFn();
    const now = Date.now();
    const fresh = state.key === key && now - state.at < ttlMs && state.data !== null; // * cache hit only when key matches, data is not null, and within TTL
    if (fresh) return Promise.resolve(state.data);
    if (state.inflight && state.key === key) return state.inflight; // * if there's already an in-flight load for the same key, return that Promise instead of calling loader again

    const inflight = (async () => { // * call the loader to get fresh data, and update the cache state when it resolves
      const data = await loader();
      state = { key, at: Date.now(), data, inflight: null };
      return data;
    })();

    state = { ...state, key, inflight }; // * update the state with the new key and in-flight Promise, but keep the old data until the new load resolves
    inflight.catch(() => { // * if the loader fails, clear the in-flight state so that the next call will retry
      if (state.inflight === inflight) state.inflight = null;
    });

    return inflight;
  };

  return {
    get,
    _peek: () => ({ key: state.key, at: state.at, hasData: state.data !== null }), // * for testing: check the current cache key, timestamp, and whether it has data without triggering a load
  };
};

/**
 * Returns the YYYY-MM-DD string of the current shift's start, given an
 * hour-of-day shift boundary. If `now` is before the boundary, returns
 * yesterday's date; otherwise today's. Used to key the cache so that at the
 * shift rollover, the stale-day entry is bypassed even within TTL.
 */
const shiftStartDate = (now, startHour) => {
  const m = now.clone();
  if (m.hour() < startHour) m.subtract(1, "day");
  return m.format("YYYY-MM-DD");
};

module.exports = { createRunningTimeCache, shiftStartDate };
