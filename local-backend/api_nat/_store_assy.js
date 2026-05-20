/**
 * Factory for standalone ASSY process stores (ALU, AOD, ARP, AVS, FIM, GSSM, MBR, MBR_F).
 *
 * All 8 share the same SQL shape (withPlanStop, startHour=6, NAT_MQTT_ASSY broker,
 * nat_mc_assy_<processName> DB), so they get one factory instead of 8 copies.
 *
 * ANT lives in _store_ant.js separately because it uses the dual-spindle
 * `master_mc_no_front_rear` + `_new` DB suffix.
 *
 * Usage:
 *   const { getStore } = require("./_store_assy");
 *   const store = getStore("ALU");
 *   store.getSnapshot();
 *   store.getRunningTime();
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");
const { buildRunningTimeSql } = require("../util/buildRunningTimeSql");

const startHour = 6;
const stores = new Map();

const buildStore = (processName) => {
  const DATABASE_PROD = `[nat_mc_assy_${processName.toLowerCase()}].[dbo].[DATA_PRODUCTION_${processName.toUpperCase()}]`;
  const DATABASE_ALARM = `[nat_mc_assy_${processName.toLowerCase()}].[dbo].[DATA_ALARMLIS_${processName.toUpperCase()}]`;
  const DATABASE_MASTER = `[nat_mc_assy_${processName.toLowerCase()}].[dbo].[DATA_MASTER_${processName.toUpperCase()}]`;

  const hub = getHub(`mqtt://${process.env.NAT_MQTT_ASSY}:${process.env.MQTT_PORT}`);

  const store = createProcessStore({
    processName,
    startHour,
    hub,// * for subscribe mqtt topic 
    masterLoader: () => master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER), //* for get array machine data from Table(SQL)
  });

  const runningTimeCache = createRunningTimeCache({
    ttlMs: 20_000,
    keyFn: () => `NAT-${processName}-${shiftStartDate(moment(), startHour)}`,
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

const getStore = (processName) => {
  if (!stores.has(processName)) {
    stores.set(processName, buildStore(processName));
  }
  return stores.get(processName);
};

module.exports = { getStore };
