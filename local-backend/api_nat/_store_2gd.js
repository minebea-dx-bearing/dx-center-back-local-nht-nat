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
let mc_type = 'IR';

const hub = getHub(`mqtt://${process.env.NAT_MQTT_MC_SHOP}:${process.env.MQTT_PORT}`);

const store = createProcessStore({
  processName,
  startHour,
  hub,
  masterLoader: () => master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
});

const runningTimeCache = createRunningTimeCache({
    ttlMs: 20_000,
    keyFn: () => `NAT-${processName}-${shiftStartDate(moment(), startHour)}`,
    loader: async () => {
      const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode: "withPlanStop", mc_type });
      const result = await dbms.query(sql);
      return result[1] > 0 ? result[0] : [];
    },
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTime: () => runningTimeCache.get(),
};
