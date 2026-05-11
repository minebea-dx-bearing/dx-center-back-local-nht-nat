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

const processName = "TN";
const startHour = 5;
const startMinuteStr = "30";
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

const sqlRunningTime = () => `
  DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${String(startHour).padStart(2, "0")}:${startMinuteStr}:00';
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
      AND ([alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_')
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
    SUM([duration_seconds]) AS [sum_duration],
    DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
  FROM [filter_time]
  GROUP BY [mc_no]
`;

const runningTimeCache = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `${processName}-${shiftStartDate(moment(), startHour)}`,
  loader: async () => {
    const result = await dbms.query(sqlRunningTime());
    return result[1] > 0 ? result[0] : [];
  },
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTime: () => runningTimeCache.get(),
};
