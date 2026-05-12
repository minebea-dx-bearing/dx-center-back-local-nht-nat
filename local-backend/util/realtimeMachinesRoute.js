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

const SUMMARY_FIELDS = {
  standard: { target: "target_pd", ok: "act_pd", ct: "act_ct", utl: "curr_utl" },
  fSpindle: { target: "f_target_pd", ok: "s_act_pd", ct: "s_act_ct", utl: "s_curr_utl" },
  sSpindle: { target: "s_target_pd", ok: "s_act_pd", ct: "s_act_ct", utl: "s_curr_utl" },
};

const summarize = (dataArray, fields) => {
  const acc = dataArray.reduce(
    (a, item) => {
      a.total_target += item[fields.target] || 0;
      a.total_ok += item[fields.ok] || 0;
      a.total_cycle_t += item[fields.ct] || 0;
      a.total_utl += item[fields.utl] || 0;
      a.count += 1;
      return a;
    },
    { total_target: 0, total_ok: 0, total_cycle_t: 0, total_utl: 0, count: 0 },
  );

  return {
    sum_target: acc.total_target,
    sum_daily_ok: acc.total_ok,
    avg_cycle_t: acc.count > 0 ? Number((acc.total_cycle_t / acc.count).toFixed(2)) : 0,
    avg_utl: acc.count > 0 ? Number((acc.total_utl / acc.count).toFixed(2)) : 0,
  };
};

const makeMachinesHandler = ({ getMachines, getRunningTime, prepareRealtimeData, summary }) => {
  const fields = summary ? SUMMARY_FIELDS[summary] : null;
  if (summary && !fields) throw new Error(`makeMachinesHandler: unknown summary "${summary}"`);

  return async (req, res) => {
    try {
      const now = moment();
      const [machines, runningTime] = await Promise.all([Promise.resolve(getMachines()), getRunningTime()]);
      const dataArray = prepareRealtimeData(machines, runningTime, now);
      const body = { success: true, data: dataArray };
      if (fields) body.resultSummary = summarize(dataArray, fields);
      res.json(body);
    } catch (error) {
      console.error("API Error in /machines: ", error);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  };
};

module.exports = { makeMachinesHandler };
