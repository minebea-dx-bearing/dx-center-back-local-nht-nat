/**
 * Builds the running-time SQL used by every `_store_*.js`. The CTE chain
 * (base_alarm → with_pairing → paired_alarms → filter_time) is identical
 * across all stores; only the WHERE filter, the final SELECT shape, and the
 * shift start time vary.
 *
 * Modes:
 *   - "withPlanStop"    : standard (RUN + PLAN STOP + SETUP), grouped by mc_no + alarm_base,
 *                         CASE-based sum_duration / sum_planshutdown_duration.
 *                         Used by 2GD, NAT ASSY (non-ANT), NHT ASSY (non-ANT), NHT GD, NHT MBR.
 *   - "withPlanStopAnt" : dual-spindle ANT variant — WHERE uses `RUN%` (not `%RUN`/`%RUN_`),
 *                         SELECT includes [alarm_base] so the consumer can pick
 *                         "RUN FRONT" vs "RUN REAR" rows, sum_duration CASE matches
 *                         "RUN REAR%"/"RUN FRONT%", PLAN STOP/SETUP match uses LIKE.
 *   - "runOnly"         : RUN-only (no plan-shutdown column), grouped by mc_no.
 *                         Used by 2GD (OutSuper variant) and TN.
 *
 * The startMinute argument supports TN (05:30 boundary).
 */

const moment = require("moment");

const ALARM_FILTERS = {
  withPlanStop: `([alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%')`,
  withPlanStopAnt: `([alarm] LIKE 'RUN%' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%')`,
};

const FINAL_SELECTS = {
  withPlanStop: `
  SELECT
    [mc_no],
    CASE WHEN [alarm_base] LIKE '%RUN' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_duration],
    CASE WHEN [alarm_base] = 'PLAN STOP' OR [alarm_base] = 'SETUP' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_planstop_duration],
    DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
  FROM [filter_time]
  GROUP BY [mc_no], [alarm_base]`,

  withPlanStopAnt: `
  ,[alarm_f] AS (
			SELECT
				LEFT([mc_no], 3) + '0' + CONVERT(VARCHAR(10), (CONVERT(INT, RIGHT([mc_no], 2)) * 2)) AS [mc_no],
				[alarm_base],
				CASE WHEN [alarm_base] LIKE 'RUN FRONT%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_duration],
				CASE WHEN [alarm_base] LIKE 'PLAN STOP%' OR [alarm_base] LIKE 'SETUP%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_planstop_duration],
				DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
			FROM [filter_time]
			WHERE [alarm_base] LIKE 'RUN FRONT%' OR [alarm_base] LIKE 'PLAN STOP%' OR [alarm_base] LIKE 'SETUP%'
			GROUP BY [mc_no], [alarm_base]
		),
		[alarm_r] AS (
			SELECT
				LEFT([mc_no], 3) + '0' + CONVERT(VARCHAR(10), CONVERT(INT, RIGHT([mc_no], 2)) + (CONVERT(INT, RIGHT([mc_no], 2)) - 1)) AS [mc_no],
				[alarm_base],
				CASE WHEN [alarm_base] LIKE 'RUN REAR%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_duration],
				CASE WHEN [alarm_base] LIKE 'PLAN STOP%' OR [alarm_base] LIKE 'SETUP%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_planstop_duration],
				DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
			FROM [filter_time]
			WHERE [alarm_base] LIKE 'RUN REAR%' OR [alarm_base] LIKE 'PLAN STOP%' OR [alarm_base] LIKE 'SETUP%'
			GROUP BY [mc_no], [alarm_base]
		)
		SELECT * FROM [alarm_f]
		UNION
		SELECT * FROM [alarm_r]`,

};

const buildRunningTimeSql = ({ alarmTable, startHour, startMinute = 0, mode }) => {
  const alarmFilter = ALARM_FILTERS[mode];
  const finalSelect = FINAL_SELECTS[mode];
  if (!alarmFilter || !finalSelect) throw new Error(`buildRunningTimeSql: unknown mode "${mode}"`);

  const hh = String(startHour).padStart(2, "0");
  const mm = String(startMinute).padStart(2, "0");

  return `
  DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${hh}:${mm}:00';
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
    FROM ${alarmTable}
    WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1
      AND ${alarmFilter}
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
${finalSelect}
`;
};

module.exports = { buildRunningTimeSql };
