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
  let state = { key: null, at: 0, data: null, inflight: null };

  const get = () => {
    const key = keyFn();
    const now = Date.now();
    const fresh = state.key === key && now - state.at < ttlMs && state.data !== null;
    if (fresh) return Promise.resolve(state.data);
    if (state.inflight && state.key === key) return state.inflight;

    const inflight = (async () => {
      const data = await loader();
      state = { key, at: Date.now(), data, inflight: null };
      return data;
    })();

    state = { ...state, key, inflight };
    inflight.catch(() => {
      if (state.inflight === inflight) state.inflight = null;
    });

    return inflight;
  };

  return {
    get,
    _peek: () => ({ key: state.key, at: state.at, hasData: state.data !== null }),
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
