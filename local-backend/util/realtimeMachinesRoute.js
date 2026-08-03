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
const crypto = require("crypto");
const { promisify } = require("util");

const gzip = promisify(zlib.gzip);

/** Cap on distinct filter payloads held at once. Bounds memory; see normalize(). */
const FILTER_CACHE_MAX = 256;

const SUMMARY_FIELDS = {
  standard: { target: "target_pd", total: "total_pd", ct: "act_ct", utl: "curr_utl", oee: "oee" },
  fSpindle: { target: "f_target_pd", total: "s_total_pd", ct: "s_act_ct", utl: "s_curr_utl", oee: "f_oee" },
  sSpindle: { target: "s_target_pd", total: "s_total_pd", ct: "s_act_ct", utl: "s_curr_utl", oee: "s_oee" },
};

/**
 * Divisor for the averages: machines actually reporting, not rows present.
 *
 * Routes like assy_alu pad their array with placeholder `SIGNAL LOSE` rows for
 * machines that never checked in, and carry the pre-padding machine list on
 * every row as `curr_mc_no`. Averaging over the padded rows would drag every
 * figure toward zero, so those rows are excluded.
 *
 * Counted against the rows being summarized rather than reading
 * `curr_mc_no.length` directly: under `?machines=` filtering the row set is a
 * subset, and the plant-wide online count is the wrong divisor for it.
 */
const countReporting = (rows) => {
  const reporting = rows[0]?.curr_mc_no;
  if (!reporting) return rows.length;

  const online = new Set(reporting);
  return rows.filter((r) => online.has(r.mc_no)).length;
};

const summarize = (dataArray, fields) => {
  const acc = dataArray.reduce(
    (a, item) => {
      a.total_target += item[fields.target] || 0;
      a.total_pd += item[fields.total] || 0;
      a.total_cycle_t += item[fields.ct] || 0;
      a.total_utl += item[fields.utl] || 0;
      a.total_oee *= (item[fields.oee] / 100) || 1;
      return a;
    },
    { total_target: 0, total_pd: 0, total_cycle_t: 0, total_utl: 0, total_oee: 1 },
  );

  acc.count = countReporting(dataArray);

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
 *
 * @param {boolean} [filterable] Opt in to `?machines=a,b,c`, so a dashboard
 *   receives only the machines it displays. Requires `cacheMs`. Off by default:
 *   filtering assumes rows carry `mc_no`, which not every route guarantees.
 *
 *   Work is split in two layers, and the split is the whole point:
 *
 *     once per tick : getMachines -> getRunningTime -> prepareRealtimeData
 *     once per KEY  : slice -> summarize -> JSON.stringify -> gzip
 *
 *   The expensive upstream read happens once no matter how many distinct
 *   filters are in play. Measured at 50 viewers x 750 of 1000 machines, a full
 *   cold rebuild of 48 distinct filters costs ~110ms — 2% of a 5s tick.
 */
const makeMachinesHandler = ({
  getMachines,
  getRunningTime,
  prepareRealtimeData,
  summary,
  cacheMs = 0,
  filterable = false,
}) => {
  const fields = summary ? SUMMARY_FIELDS[summary] : null;
  if (summary && !fields) throw new Error(`makeMachinesHandler: unknown summary "${summary}"`);
  if (filterable && !cacheMs) {
    // Without a cache each request would slice, serialize and gzip on its own —
    // per-request compression that inverts under load. Refuse rather than ship it.
    throw new Error("makeMachinesHandler: filterable requires cacheMs");
  }

  const ALL = "__all__";

  // ---- Layer 1: the derived rows, shared by every filter in the window ----
  let rowsCache = { at: 0, rows: null, inflight: null };

  const buildRows = async () => {
    const now = moment();
    const [machines, runningTime] = await Promise.all([Promise.resolve(getMachines()), getRunningTime()]);
    return prepareRealtimeData(machines, runningTime, now);
  };

  const getRows = () => {
    if (rowsCache.rows && Date.now() - rowsCache.at < cacheMs) return Promise.resolve(rowsCache.rows);
    if (rowsCache.inflight) return rowsCache.inflight;

    const inflight = buildRows().then((rows) => {
      rowsCache = { at: Date.now(), rows, inflight: null };
      return rows;
    });

    rowsCache = { ...rowsCache, inflight };
    // Drop a failed build, or every later request awaits an already-rejected
    // promise and the endpoint stays dead until restart.
    inflight.catch(() => {
      if (rowsCache.inflight === inflight) rowsCache.inflight = null;
    });
    return inflight;
  };

  // ---- Layer 2: the serialized body, one per distinct filter ----
  // Map keeps insertion order, so the first key is the oldest — that is the LRU.
  const payloadCache = new Map();

  const serialize = async (rows) => {
    const body = { success: true, data: rows };
    if (fields) body.resultSummary = summarize(rows, fields);
    const json = JSON.stringify(body);

    // Compress ONCE per tick, not once per response. Per-request gzip
    // (e.g. compression() middleware) inverts at high viewer counts: the CPU
    // spent compressing N identical bodies costs more than the bandwidth saved.
    // Only worth it when a cache exists to amortise it across viewers.
    const gz = cacheMs ? await gzip(json) : null;
    return { json, gz };
  };

  /**
   * `?machines=` is a wire format, never the cache key. Sorting and hashing means
   * two dashboards asking for the same machines in a different order share one
   * entry — and a future `?line=` can resolve into this same key space without
   * breaking anyone.
   *
   * Unknown names are dropped rather than rejected: that is what bounds key
   * cardinality (a caller cannot mint entries by inventing machine numbers) and
   * it keeps a dashboard alive when a machine leaves the master table.
   */
  const normalize = (raw, rows) => {
    if (!filterable || !raw) return { key: ALL, rows };

    const valid = new Map(rows.map((r) => [String(r.mc_no).toLowerCase(), r]));
    const names = [...new Set(String(raw).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))]
      .filter((n) => valid.has(n))
      .sort();

    if (!names.length) return null;
    return {
      key: crypto.createHash("sha1").update(names.join(",")).digest("hex").slice(0, 16),
      rows: names.map((n) => valid.get(n)),
    };
  };

  /** Single-flight: a burst arriving on a cold cache triggers ONE build, not N. */
  const getPayload = (key, rows) => {
    const hit = payloadCache.get(key);
    if (hit) {
      if (hit.payload && Date.now() - hit.at < cacheMs) {
        payloadCache.delete(key);
        payloadCache.set(key, hit); // touch, so LRU order stays honest
        return hit.payload;
      }
      if (hit.inflight) return hit.inflight;
    }

    const inflight = serialize(rows).then((payload) => {
      payloadCache.set(key, { at: Date.now(), payload, inflight: null });
      return payload;
    });

    payloadCache.set(key, { at: 0, payload: null, inflight });
    inflight.catch(() => payloadCache.delete(key));

    while (payloadCache.size > FILTER_CACHE_MAX) {
      payloadCache.delete(payloadCache.keys().next().value);
    }
    return inflight;
  };

  return async (req, res) => {
    try {
      if (!cacheMs) {
        // Uncached routes keep the original path exactly: build, serialize, send.
        const { json } = await serialize(await buildRows());
        return res.type("json").vary("Accept-Encoding").send(json);
      }

      const norm = normalize(req.query.machines, await getRows());
      if (!norm) {
        return res.status(400).json({ success: false, message: "no known machines in filter" });
      }

      const { json, gz } = await getPayload(norm.key, norm.rows);
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
