/**
 * Shared per-process-family store. Replaces the per-file pattern of:
 *   - module-level `machineData = {}`
 *   - `reloadMasterData()` + setInterval(5 min)
 *   - `mqtt.connect(...)` + subscribe("#") + message handler
 *   - `queryCurrentRunningTime()` re-running on every API request
 *
 * One store instance owns master data, live data, and the running-time cache
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
const { createRunningTimeCache, shiftStartDate } = require("./runningTimeCache");

const DEFAULT_RELOAD_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 20 * 1000;

const createProcessStore = ({
  processName,
  startHour,
  hub,
  masterLoader, // async () => Array<row>
  runningTimeLoader, // async () => Array<row>
  ttlMs = DEFAULT_TTL_MS,
  reloadIntervalMs = DEFAULT_RELOAD_MS,
}) => {
  const master = {}; // mc_no -> whole SQL row
  const live = {}; // mc_no -> accumulated MQTT fields

  const reloadMaster = async () => {
    try {
      const rows = await masterLoader();
      if (!rows) return;

      const seen = new Set();
      for (const row of rows) {
        master[row.mc_no] = row;
        seen.add(row.mc_no);
      }

      for (const mc_no of Object.keys(master)) {
        if (!seen.has(mc_no)) {
          console.info(`[${processName}] machine removed from SQL: ${mc_no}`);
          delete master[mc_no];
          delete live[mc_no];
        }
      }

      console.info(`[${processName}] master reloaded — ${Object.keys(master).length} machines`);
    } catch (err) {
      console.error(`[${processName}] master reload failed:`, err.message);
    }
  };

  hub.register({
    accepts: (mc_no) => Object.prototype.hasOwnProperty.call(master, mc_no),
    onMessage: (mc_no, payload) => {
      live[mc_no] = {
        ...live[mc_no],
        ...payload,
        updated_at: moment().format("YYYY-MM-DD HH:mm:ss"),
        source: "MQTT",
      };
    },
  });

  const runningTimeCache = createRunningTimeCache({
    ttlMs,
    keyFn: () => `${processName}-${shiftStartDate(moment(), startHour)}`,
    loader: runningTimeLoader,
  });

  const mergeOne = (mc_no) => {
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

  const getSnapshot = (filterFn) => {
    const out = [];
    for (const mc_no of Object.keys(master)) {
      if (filterFn && !filterFn(mc_no)) continue;
      const merged = mergeOne(mc_no);
      if (merged) out.push(merged);
    }
    return out;
  };

  const getRawMap = () => {
    const out = {};
    for (const mc_no of Object.keys(master)) {
      const merged = mergeOne(mc_no);
      if (merged) out[mc_no] = merged;
    }
    return out;
  };

  reloadMaster();
  setInterval(reloadMaster, reloadIntervalMs);

  return {
    getSnapshot,
    getRawMap,
    getRunningTime: () => runningTimeCache.get(),
    _debug: { master, live, runningTimeCache },
  };
};

module.exports = { createProcessStore };
