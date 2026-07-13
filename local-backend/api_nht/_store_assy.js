/**
 * Factory for templated NHT ASSY process stores (ALU, AOD, AVS, FIM, GSSM, MBRF).
 *
 * All 6 share:
 *   - startHour 6
 *   - DB stem `data_machine_<processName.toLowerCase()>`
 *   - broker `process.env.NHT_MQTT_ASSY_FRONT`
 *   - master util `master_mc_no`
 *   - standard withPlanStop SQL
 *
 * Per-process knobs:
 *   - `alarmTableSuffix` differs: most use `DATA_ALARMLIS`, but GSSM and MBR_F
 *     use `DATA_ALARMLIST` (extra T). Pass via opts.
 *
 * ANT lives in _store_ant.js (dual-spindle, hardcoded broker).
 * MBR lives in _store_mbr.js (custom DB stem `data_machine_assy1`).
 *
 * Usage:
 *   const { getStore } = require("./_store_assy");
 *   const store = getStore("ALU");
 *   const gssm = getStore("GSSM", { alarmTableSuffix: "DATA_ALARMLIST" });
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nht");
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const startHour = 6;
const stores = new Map();

const buildStore = (processName, opts = {}) => {
  const lc = processName.toLowerCase();
  const uc = processName.toUpperCase();
  const dbStem = opts.dbStem || `data_machine_${lc}`;
  const alarmTableSuffix = opts.alarmTableSuffix || "DATA_ALARMLIS";

  const DATABASE_PROD = `[${dbStem}].[dbo].[DATA_PRODUCTION_${uc}]`;
  const DATABASE_ALARM = `[${dbStem}].[dbo].[${alarmTableSuffix}_${uc}]`;
  const DATABASE_MASTER = `[${dbStem}].[dbo].[DATA_MASTER_${uc}]`;

  const hub = getHub(`mqtt://${process.env.NHT_MQTT_ASSY_FRONT}:${process.env.MQTT_PORT}`);

  const store = createProcessStore({
    processName,
    startHour,
    hub,
    masterLoader: () => master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
  });

  const runningTimeCache = createRunningTimeCache({
    ttlMs: 20_000,
    keyFn: () => `NHT-${processName}-${shiftStartDate(moment(), startHour)}`,
    loader: async () => {
      const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode: "withPlanStop" });
      const result = await dbms.query(sql);
      return result[1] > 0 ? result[0] : [];
    },
  });

  return {
    getSnapshot: store.getSnapshot,
    getRawMap: store.getRawMap,
    getRunningTime: () => runningTimeCache.get(),
  };
};

const getStore = (processName, opts) => {
  const key = `${processName}|${opts?.dbStem || ""}|${opts?.alarmTableSuffix || ""}`;
  if (!stores.has(key)) {
    stores.set(key, buildStore(processName, opts));
  }
  return stores.get(key);
};

module.exports = { getStore };
