/**
 * Shared store for the ANT realtime route (assy_ant_realtime).
 *
 * ANT is the only dual-spindle process — its `master_mc_no_front_rear` returns
 * alarm_front/alarm_rear/occurred_front/occurred_rear and the running-time SQL
 * groups by alarm_base ("RUN FRONT" / "RUN REAR" / "PLAN STOP" / "SETUP").
 *
 * Connects to the ASSY broker (NAT_MQTT_ASSY), not the MC_SHOP broker.
 * Uses the `_new` database suffix (nat_mc_assy_ant_new).
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");
const master_mc_no_front_rear = require("../util/mqtt_master_mc_no_front_rear");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const processName = "ANT";
const startHour = 6;
const DATABASE_PROD = `[nat_mc_assy_${processName.toLowerCase()}_new].[dbo].[DATA_PRODUCTION_${processName.toUpperCase()}]`;
const DATABASE_ALARM = `[nat_mc_assy_${processName.toLowerCase()}_new].[dbo].[DATA_ALARMLIS_${processName.toUpperCase()}]`;
const DATABASE_MASTER = `[nat_mc_assy_${processName.toLowerCase()}_new].[dbo].[DATA_MASTER_${processName.toUpperCase()}]`;

const hub = getHub(`mqtt://${process.env.NAT_MQTT_ASSY}:${process.env.MQTT_PORT}`);

const store = createProcessStore({
  processName,
  startHour,
  hub,
  masterLoader: () => master_mc_no_front_rear(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
});

const runningTimeCache = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `${processName}-${shiftStartDate(moment(), startHour)}`,
  loader: async () => {
    const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode: "withPlanStopAnt" });
    const result = await dbms.query(sql);
    return result[1] > 0 ? result[0] : [];
  },
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTime: () => runningTimeCache.get(),
};
