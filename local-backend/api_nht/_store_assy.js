/**
 * Factory for templated NHT ASSY process stores (ALU, AOD, AVS, FIM, GSSM, MBRF).
 *
 * All 6 share:
 *   - startHour 6
 *   - DB stem `data_machine_<processName.toLowerCase()>`
 *   - broker `process.env.NHT_MQTT_ASSY`
 *   - master util `master_mc_no`
 *   - standard withPlanStop SQL
 *
 * Per-process knobs:
 *   - `alarmTableSuffix` differs: most use `DATA_ALARMLIS`, but GSSM and MBR_F
 *     use `DATA_ALARMLIST` (extra T). Pass via opts.
 *
 * ANT lives in _store_ant.js (dual-spindle, hardcoded broker).
 * MBR lives in _store_mbr.js (custom DB stem `data_machine_assy1`).
 *
 * Usage:
 *   const { getStore } = require("./_store_assy");
 *   const store = getStore("ALU");
 *   const gssm = getStore("GSSM", { alarmTableSuffix: "DATA_ALARMLIST" });
 */

const moment = require("moment");
const dbms = require("../instance/ms_instance_nht");
const master_mc_no = require("../util/mqtt_master_mc_no");
const { getHub } = require("../util/mqttHub");
const { createProcessStore } = require("../util/processStore");
const { createRunningTimeCache, shiftStartDate } = require("../util/runningTimeCache");

const startHour = 6;
const stores = new Map();

const buildStore = (processName, opts = {}) => {
  const lc = processName.toLowerCase();
  const uc = processName.toUpperCase();
  const dbStem = opts.dbStem || `data_machine_${lc}`;
  const alarmTableSuffix = opts.alarmTableSuffix || "DATA_ALARMLIS";

  const DATABASE_PROD = `[${dbStem}].[dbo].[DATA_PRODUCTION_${uc}]`;
  const DATABASE_ALARM = `[${dbStem}].[dbo].[${alarmTableSuffix}_${uc}]`;
  const DATABASE_MASTER = `[${dbStem}].[dbo].[DATA_MASTER_${uc}]`;

  const hub = getHub(`mqtt://${process.env.NHT_MQTT_ASSY}:${process.env.MQTT_PORT}`);

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
    keyFn: () => `NHT-${processName}-${shiftStartDate(moment(), startHour)}`,
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

const getStore = (processName, opts) => {
  const key = `${processName}|${opts?.dbStem || ""}|${opts?.alarmTableSuffix || ""}`;
  if (!stores.has(key)) {
    stores.set(key, buildStore(processName, opts));
  }
  return stores.get(key);
};

module.exports = { getStore };
