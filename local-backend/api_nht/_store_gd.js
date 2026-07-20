/**
 * Shared store for the GD realtime route (gd_2ndInBore_realtime).
 *
 * NHT only has the InBore variant for GD (NAT has 5 — Bore, Race, Super × In/Out).
 * Standard withPlanStop SQL (RUN + PLAN STOP + SETUP).
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nht");
const master_mc_no_status = require("../util/mqtt_master_mc_no_status");
// const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const processName = "GD";
const startHour = 7;
const DATABASE_PROD = `[data_machine_gd2].[dbo].[DATA_PRODUCTION_${processName.toUpperCase()}]`;
const DATABASE_ALARM = `[data_machine_gd2].[dbo].[DATA_MCSTATUS_${processName.toUpperCase()}]`;
const DATABASE_MASTER = `[data_machine_gd2].[dbo].[DATA_MASTER_${processName.toUpperCase()}]`;

const hub = getHub(`mqtt://${process.env.NHT_MQTT_MC_SHOP}:${process.env.MQTT_PORT}`);

const store = createProcessStore({
  processName,
  startHour,
  hub,
  masterLoader: () => master_mc_no_status(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
});

const runningTimeCache = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `NHT-${processName}-${shiftStartDate(moment(), startHour)}`,
  loader: async () => {
    const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode: "withPlanStop", dataType:"status" });
    const result = await dbms.query(sql);
    return result[1] > 0 ? result[0] : [];
  },
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTime: () => runningTimeCache.get(),
};
