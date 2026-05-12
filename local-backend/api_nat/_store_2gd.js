/**
 * Shared store for the five 2GD realtime routes:
 *   gd_2ndInBore_realtime, gd_2ndInRace_realtime, gd_2ndInSuper_realtime,
 *   gd_2ndOutRace_realtime, gd_2ndOutSuper_realtime
 *
 * Replaces 5× duplicated:
 *   - mqtt.connect + subscribe("#")
 *   - reloadMasterData + setInterval(5 min)
 *   - module-level machineData
 *   - queryCurrentRunningTime (un-cached, ran per request)
 *
 * Exposes two running-time caches:
 *   - getRunningTimeWithPlanStop: includes RUN + PLAN STOP + SETUP alarm bases
 *     and returns sum_duration + sum_planshutdown_duration. Used by InBore,
 *     InRace, InSuper, OutRace.
 *   - getRunningTimeRunOnly: RUN-class alarms only, returns sum_duration.
 *     Used by OutSuper (which historically did not account for plan shutdowns).
 *
 * Behavior is byte-equivalent to the pre-refactor SQL of each consumer.
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const processName = "2GD";
const startHour = 7; // reset at 7 o'clock
const DATABASE_PROD = `[nat_mc_mcshop_${processName.toLowerCase()}].[dbo].[DATA_PRODUCTION_${processName.toUpperCase()}]`;
const DATABASE_ALARM = `[nat_mc_mcshop_${processName.toLowerCase()}].[dbo].[DATA_ALARMLIS_${processName.toUpperCase()}]`;
const DATABASE_MASTER = `[nat_mc_mcshop_${processName.toLowerCase()}].[dbo].[DATA_MASTER_${processName.toUpperCase()}]`;

const hub = getHub(`mqtt://${process.env.NAT_MQTT_MC_SHOP}:${process.env.MQTT_PORT}`);

const store = createProcessStore({
  processName,
  startHour,
  hub,
  masterLoader: () => master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
});

const shiftDateKey = () => `${processName}-${shiftStartDate(moment(), startHour)}`;

const makeLoader = (mode) => async () => {
  const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode });
  const result = await dbms.query(sql);
  return result[1] > 0 ? result[0] : [];
};

const runningTimeWithPlanStop = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `${shiftDateKey()}-withPS`,
  loader: makeLoader("withPlanStop"),
});

const runningTimeRunOnly = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `${shiftDateKey()}-runOnly`,
  loader: makeLoader("runOnly"),
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTimeWithPlanStop: () => runningTimeWithPlanStop.get(),
  getRunningTimeRunOnly: () => runningTimeRunOnly.get(),
};
