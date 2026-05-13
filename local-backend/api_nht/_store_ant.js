/**
 * Shared store for the ANT realtime route (assy_ant_realtime, NHT).
 *
 * Dual-spindle: uses `master_mc_no_front_rear` and groups by alarm_base
 * ("RUN FRONT" / "RUN REAR" / "PLAN STOP" / "SETUP").
 *
 * Broker: process.env.NHT_MQTT_ASSY_FRONT.
 *
 * DB stem `data_machine_an2`; table suffix uses dbProcess = "AN".
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nht");
const master_mc_no_front_rear = require("../util/mqtt_master_mc_no_front_rear");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const processName = "ANT";
const dbProcess = "AN";
const startHour = 6;
const DATABASE_PROD = `[data_machine_an2].[dbo].[DATA_PRODUCTION_${dbProcess}]`;
const DATABASE_ALARM = `[data_machine_an2].[dbo].[DATA_ALARMLIS_${dbProcess}]`;
const DATABASE_MASTER = `[data_machine_an2].[dbo].[DATA_MASTER_${dbProcess}]`;

const hub = getHub(`mqtt://${process.env.NHT_MQTT_ASSY_BACK}:${process.env.MQTT_PORT}`);

const store = createProcessStore({
  processName,
  startHour,
  hub, //machine data from mqtt subscription
  masterLoader: () => master_mc_no_front_rear(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER), //data from Table(SQL)
});

const runningTimeCache = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `NHT-${processName}-${shiftStartDate(moment(), startHour)}`,
  loader: async () => {
    const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, mode: "withPlanStopAnt" });
    const result = await dbms.query(sql);
    return result[1] > 0 ? result[0] : [];
  },
});

module.exports = {
  //need to expose getSnapshot and getRunningTime for realtime route to use(need filter mc_no or not need )
  getSnapshot: store.getSnapshot,//have filter function in getSnapshot to filter machine that not exist in master (e.g. machine removed from production but still have mqtt data come in for a while until MQTT timeout)
  getRawMap: store.getRawMap,//no filter, return all machine in master and live (including machine that removed from production but still have mqtt data come in for a while until MQTT timeout)
  getRunningTime: () => runningTimeCache.get(),//get running time data from cache, which will call loader function to get data from Table(SQL) when cache miss or expired
};
