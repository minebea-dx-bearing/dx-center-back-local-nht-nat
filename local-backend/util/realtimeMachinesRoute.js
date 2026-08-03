/**
 * Builds the `GET /machines` handler that every realtime route declares
 * identically: fetch snapshot + running-time in parallel, prepare per-machine
 * rows, optionally compute a summary, return { success, data, resultSummary? }.
 *
 * Three summary shapes cover every realtime file:
 *   - "standard"  : target_pd, act_pd, act_ct, curr_utl  (14 files)
 *   - "fSpindle"  : f_target_pd, s_act_pd, s_act_ct, s_curr_utl  (ANT, GSSM × 2 envs)
 *   - "sSpindle"  : s_target_pd, s_act_pd, s_act_ct, s_curr_utl  (MBR × 2 envs)
 *
 * Files with non-standard output (AOD's avg_opn, MBRF's no-summary) stay manual.
 *
 * Usage:
 *   router.get("/machines", makeMachinesHandler({
 *     getMachines: () => store.getRawMap(),
 *     getRunningTime: store.getRunningTime,
 *     prepareRealtimeData,
 *     summary: "standard",
 *   }));
 */

const moment = require("moment");
const zlib = require("zlib");
const { promisify } = require("util");

const gzip = promisify(zlib.gzip);

const SUMMARY_FIELDS = {
  standard: { target: "target_pd", total: "total_pd", ct: "act_ct", utl: "curr_utl", oee: "oee" },
  fSpindle: { target: "f_target_pd", total: "s_total_pd", ct: "s_act_ct", utl: "s_curr_utl", oee: "f_oee" },
  sSpindle: { target: "s_target_pd", total: "s_total_pd", ct: "s_act_ct", utl: "s_curr_utl", oee: "s_oee" },
};

const summarize = (dataArray, fields) => {
  const acc = dataArray.reduce(
    (a, item) => {
      a.total_target += item[fields.target] || 0;
      a.total_pd += item[fields.total] || 0;
      a.total_cycle_t += item[fields.ct] || 0;
      a.total_utl += item[fields.utl] || 0;
      a.total_oee *= (item[fields.oee] / 100) || 1;
      if(dataArray[0].curr_mc_no) {
        a.count = dataArray[0].curr_mc_no.length;
      }
      else{
        a.count += 1
      }
      return a;
    },
    { total_target: 0, total_pd: 0, total_cycle_t: 0, total_utl: 0, count: 0, total_oee: 1 },
  );

  return {
    sum_target: acc.total_target,
    sum_daily: acc.total_pd,
    avg_cycle_t: acc.count > 0 ? Number((acc.total_cycle_t / acc.count).toFixed(2)) : 0,
    avg_utl: acc.count > 0 ? Number((acc.total_utl / acc.count).toFixed(2)) : 0,
    avg_oee: acc.total_oee * 100
  };
};

/**
 * @param {number} [cacheMs] When set, all callers within the window share ONE
 *   computed response. Every dashboard polls on the same wall-clock second
 *   (`ss === 0`), so N open tabs arrive as N simultaneous requests asking the
 *   identical question — without this, each one independently re-reads the data
 *   source and re-serializes. Defaults to 0 (no caching), so the 17 existing
 *   routes are unaffected.
 */
const makeMachinesHandler = ({ getMachines, getRunningTime, prepareRealtimeData, summary, cacheMs = 0 }) => {
  const fields = summary ? SUMMARY_FIELDS[summary] : null;
  if (summary && !fields) throw new Error(`makeMachinesHandler: unknown summary "${summary}"`);

  // Cache the SERIALIZED body: JSON.stringify over every machine is the real
  // per-request CPU cost once viewer count is high.
  let cache = { at: 0, payload: null, inflight: null };

  const build = async () => {
    const now = moment();
    const [machines, runningTime] = await Promise.all([Promise.resolve(getMachines()), getRunningTime()]);
    const dataArray = await prepareRealtimeData(machines, runningTime, now);
    const body = { success: true, data: dataArray };
    if (fields) body.resultSummary = summarize(dataArray, fields);
    const json = JSON.stringify(body);

    // Compress ONCE per tick, not once per response. Per-request gzip
    // (e.g. compression() middleware) inverts at high viewer counts: the CPU
    // spent compressing N identical bodies costs more than the bandwidth saved.
    // Only worth it when a cache exists to amortise it across viewers.
    const gz = cacheMs ? await gzip(json) : null;
    return { json, gz };
  };

  /** Single-flight: a burst arriving on a cold cache triggers ONE build, not N. */
  const getPayload = () => {
    if (!cacheMs) return build();
    if (cache.payload && Date.now() - cache.at < cacheMs) return Promise.resolve(cache.payload);
    if (cache.inflight) return cache.inflight;

    const inflight = build().then((payload) => {
      cache = { at: Date.now(), payload, inflight: null };
      return payload;
    });

    cache = { ...cache, inflight };
    inflight.catch(() => {
      if (cache.inflight === inflight) cache.inflight = null;
    });
    return inflight;
  };

  return async (req, res) => {
    try {
      const { json, gz } = await getPayload();
      res.type("json").vary("Accept-Encoding");

      if (gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
        return res.set("Content-Encoding", "gzip").send(gz);
      }
      return res.send(json);
    } catch (error) {
      console.error("API Error in /machines: ", error);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  };
};

module.exports = { makeMachinesHandler };
