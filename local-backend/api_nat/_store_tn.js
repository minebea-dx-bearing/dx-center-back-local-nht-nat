/**
 * Shared store for the TN realtime route (tn_tn_realtime).
 *
 * TN shift starts at 05:30 (not on the hour). The running-time SQL uses
 * RUN-class alarms only and does not return sum_planshutdown_duration.
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const processName = "TN";
const startHour = 5;
const startMinute = 30;
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

const runningTimeCache = createRunningTimeCache({ // * cache running time for 20 seconds to avoid hitting DB on every API request, since the running time doesn't need to be super real-time
  ttlMs: 20_000,
  keyFn: () => `${processName}-${shiftStartDate(moment(), startHour)}`,
  loader: async () => {
    const sql = buildRunningTimeSql({ alarmTable: DATABASE_ALARM, startHour, startMinute, mode: "runOnly" });
    const result = await dbms.query(sql);
    return result[1] > 0 ? result[0] : [];
  },
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap, ////"What is each machine doing right now?" (detailed data)
  getRunningTime: () => runningTimeCache.get(), //How long has the line been running this shift?
};
