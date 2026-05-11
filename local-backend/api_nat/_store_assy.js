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
    hub,
    masterLoader: () => master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER),
  });

  const sqlRunningTime = () => `
    DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${String(startHour).padStart(2, "0")}:00:00';
    DECLARE @end_date DATETIME = GETDATE();
    DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
    DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);

    WITH [base_alarm] AS (
      SELECT
        [mc_no],
        [occurred],
        [alarm],
        CASE WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1) ELSE [alarm] END AS [alarm_base],
        CASE WHEN RIGHT([alarm], 1) = '_' THEN 'after' ELSE 'before' END AS [alarm_type]
      FROM ${DATABASE_ALARM}
      WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1
        AND ([alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%')
    ),
    [with_pairing] AS (
      SELECT *,
        ISNULL(LEAD([occurred]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]), @end_date) AS [occurred_next],
        ISNULL(LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]), 'after') AS [next_type]
      FROM [base_alarm]
    ),
    [paired_alarms] AS (
      SELECT
        [mc_no],
        [alarm_base],
        CASE WHEN [occurred] < @start_date THEN @start_date ELSE [occurred] END AS [occurred_start],
        CASE WHEN [occurred_next] > @end_date THEN @end_date ELSE [occurred_next] END AS [occurred_end]
      FROM [with_pairing]
      WHERE [alarm_type] = 'before' AND [next_type] = 'after'
    ),
    [filter_time] AS (
      SELECT *, DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
      FROM [paired_alarms]
      WHERE [occurred_end] > [occurred_start]
    )
    SELECT
      [mc_no],
      CASE WHEN [alarm_base] LIKE '%RUN' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_duration],
      CASE WHEN [alarm_base] = 'PLAN STOP' OR [alarm_base] = 'SETUP' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_planshutdown_duration],
      DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
    FROM [filter_time]
    GROUP BY [mc_no], [alarm_base]
  `;

  const runningTimeCache = createRunningTimeCache({
    ttlMs: 20_000,
    keyFn: () => `${processName}-${shiftStartDate(moment(), startHour)}`,
    loader: async () => {
      const result = await dbms.query(sqlRunningTime());
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
