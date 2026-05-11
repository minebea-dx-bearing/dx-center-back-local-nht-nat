/**
 * Shared store for the ANT realtime route (assy_ant_realtime).
 *
 * ANT is the only dual-spindle process — its `master_mc_no_front_rear` returns
 * alarm_front/alarm_rear/occurred_front/occurred_rear and the running-time SQL
 * groups by alarm_base ("RUN FRONT" / "RUN REAR" / "PLAN STOP" / "SETUP").
 *
 * Connects to the ASSY broker (NAT_MQTT_ASSY), not the MC_SHOP broker.
 * Uses the `_new` database suffix (nat_mc_assy_ant_new).
 *
 * NOTE: the original SQL declared [sum_duration] twice in the SELECT clause
 * (a plain SUM and a conditional). Preserved verbatim to keep response
 * identical to current production behavior — the conditional alias is what
 * the JS layer actually consumes.
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");
const master_mc_no_front_rear = require("../util/mqtt_master_mc_no_front_rear");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");

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
      AND ([alarm] LIKE 'RUN%' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%')
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
    [alarm_base],
    SUM([duration_seconds]) AS [sum_duration],
    CASE WHEN [alarm_base] LIKE 'RUN REAR%' OR [alarm_base] LIKE 'RUN FRONT%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_duration],
    CASE WHEN [alarm_base] LIKE 'PLAN STOP%' OR [alarm_base] LIKE 'SETUP%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_planshutdown_duration],
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

module.exports = {
  getSnapshot: store.getSnapshot,
  getRawMap: store.getRawMap,
  getRunningTime: () => runningTimeCache.get(),
};
