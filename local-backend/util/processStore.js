/**
 * Shared per-process-family store. Replaces the per-file pattern of:
 *   - module-level `machineData = {}`
 *   - `reloadMasterData()` + setInterval(5 min)
 *   - `mqtt.connect(...)` + subscribe("#") + message handler
 *   - `queryCurrentRunningTime()` re-running on every API request
 *
 * One store instance owns master data and live data
 * for one process family (e.g. all five 2GD route files share `_store_2gd.js`).
 *
 * Field ownership is enforced by storage separation (not by allowlist):
 *   - master[mc_no] = whole row from masterLoader  (SQL, refreshed every reloadIntervalMs)
 *   - live[mc_no]   = accumulated MQTT payloads    (per-message merge)
 *   - read         = { ...master[mc], ...live[mc], mc_no, updated_at, source }
 *
 * See docs/field-ownership.md for the merge contract.
 */

const moment = require("moment");

const DEFAULT_RELOAD_MS = 5 * 60 * 1000; //#handle master data reload every 5 minutes by default, can be overridden by passing reloadIntervalMs to createProcessStore()

const createProcessStore = ({
  processName,
  startHour,
  hub,
  masterLoader, // async () => Array<row>
  reloadIntervalMs = DEFAULT_RELOAD_MS,
}) => {
  const master = {}; // mc_no list -> whole SQL row
  const live = {}; // mc_no list -> accumulated MQTT fields

  const reloadMaster = async () => {
    try {
      const rows = await masterLoader(); // * execute SQL query and get array of machine data
      if (!rows) return;
      // console.log(rows)

      const seen = new Set();
      for (const row of rows) { 
        master[row.mc_no] = row;
        seen.add(row.mc_no); // * track which machines are present in the new SQL result, so we can remove machines that are removed from production */
      }

      for (const mc_no of Object.keys(master)) { // * remove machine that exist in master but not exist in new SQL result (e.g. machine removed from production)
        if (!seen.has(mc_no)) {
          console.info(`[${processName}] machine removed from SQL: ${mc_no}`);
          delete master[mc_no];
          delete live[mc_no];
        }
      } //Without it, removed machines would stay in memory forever

      console.info(`[${processName}] master reloaded — ${Object.keys(master).length} machines`);
    } catch (err) {
      console.error(`[${processName}] master reload failed:`, err.message);
    }
  };

  hub.register({ //subscribe MQTT topic and update live data on message
    accepts: (mc_no) => Object.prototype.hasOwnProperty.call(master, mc_no),
    onMessage: (mc_no, realtimeCache, topic) => {
      // console.log(mc_no, realtimeCache)
      live[mc_no] = {
        ...live[mc_no],
        ...(realtimeCache.data || {}),
        mqtt_alarm: realtimeCache.alarm?.status || null, 
        mqtt_status: realtimeCache.status?.status || null,
        ...(realtimeCache.mqtt || {}),
        updated_at: moment().format("YYYY-MM-DD HH:mm:ss"),
        source: "MQTT",
      };
      // console.log(mc_no, live[mc_no])
    },
  });

  const mergeOne = (mc_no) => { // * merge master data and live data for one machine, live data take precedence over master data when field overlap (e.g. updated_at, source)
    const m = master[mc_no];
    if (!m) return null;
    const l = live[mc_no] || {};
    return {
      ...m,
      ...l,
      mc_no,
      source: l.source || "SQL",
    };
  };

  const getSnapshot = (filterFn) => {// * get array of merged data for all machines, optionally filtered by filterFn(mc_no) */
    const out = [];
    for (const mc_no of Object.keys(master)) {
      if (filterFn && !filterFn(mc_no)) continue;
      const merged = mergeOne(mc_no);
      if (merged) out.push(merged);
    }
    return out;
  };

  const getRawMap = () => {// * get map of merged data for all machines, keyed by mc_no (for API routes that need to look up machines individually) */
    const out = {};
    // console.log(master)
    for (const mc_no of Object.keys(master)) {
      const merged = mergeOne(mc_no);
      if (merged) out[mc_no] = merged;
    }
    return out;
  };

  reloadMaster();// * initial load, then schedule reload every reloadIntervalMs (default 5 minutes) */
  setInterval(reloadMaster, reloadIntervalMs); // * schedule master data reload every reloadIntervalMs (default 5 minutes)

  return {
    getSnapshot,
    getRawMap,
    _debug: { master, live },
  };
};

module.exports = { createProcessStore };
