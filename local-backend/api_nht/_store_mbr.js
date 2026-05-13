/**
 * ⚠ LEGACY — DO NOT REPLICATE THIS PATTERN.
 * New MBR-like processes should use api_nht/_store_assy.js (Family A factory).
 *
 * Why this exists: MBR's data lives in `data_machine_assy1` under tables named
 * DATA_*_ASSY (not DATA_*_MBR). This was inherited from a pre-refactor structure
 * where the route had `const process = "ASSY"` which shadowed Node's global,
 * preventing env-var access and forcing a hardcoded broker IP. The migration kept
 * the DB stem to preserve backwards-compatibility with the existing tables.
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nht");
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const processName = "MBR";
const dbProcess = "ASSY";
const startHour = 6;
const DATABASE_PROD = `[data_machine_assy1].[dbo].[DATA_PRODUCTION_${dbProcess}]`;
const DATABASE_ALARM = `[data_machine_assy1].[dbo].[DATA_ALARMLIS_${dbProcess}]`;
const DATABASE_MASTER = `[data_machine_assy1].[dbo].[DATA_MASTER_${dbProcess}]`;

const hub = getHub(`mqtt://${process.env.NHT_MQTT_ASSY_BACK}:${process.env.MQTT_PORT}`);

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

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTime: () => runningTimeCache.get(),
};
