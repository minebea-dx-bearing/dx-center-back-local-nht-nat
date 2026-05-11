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

const processName = "2GD";
const startHour = 7;
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

const sqlHeader = () => `
  DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${String(startHour).padStart(2, "0")}:00:00';
  DECLARE @end_date DATETIME = GETDATE();
  DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
  DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);
`;

const sqlRunningTimeWithPlanStop = () => `
  ${sqlHeader()}

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

const sqlRunningTimeRunOnly = () => `
  ${sqlHeader()}

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

const makeLoader = (sqlFn) => async () => {
  const result = await dbms.query(sqlFn());
  return result[1] > 0 ? result[0] : [];
};

const runningTimeWithPlanStop = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `${shiftDateKey()}-withPS`,
  loader: makeLoader(sqlRunningTimeWithPlanStop),
});

const runningTimeRunOnly = createRunningTimeCache({
  ttlMs: 20_000,
  keyFn: () => `${shiftDateKey()}-runOnly`,
  loader: makeLoader(sqlRunningTimeRunOnly),
});

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTimeWithPlanStop: () => runningTimeWithPlanStop.get(),
  getRunningTimeRunOnly: () => runningTimeRunOnly.get(),
};
