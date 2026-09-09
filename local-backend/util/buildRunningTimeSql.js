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
 *
 * Shift anchor: @start_date is derived from GETDATE() inside SQL, not from the
 * Node clock. Shifting `now` back by the shift offset before truncating to a
 * date yields the correct shift day on both sides of midnight without a CASE —
 * between 00:00 and the boundary we are still inside YESTERDAY's shift.
 */

const buildRunningTimeSql = ({ alarmTable, startHour, startMinute = 0 }) => {
  const shiftOffsetMin = startHour * 60 + startMinute;

  const query =  `
    DECLARE @now DATETIME = GETDATE();
    DECLARE @start_date DATETIME = DATEADD(MINUTE, ${shiftOffsetMin}, CAST(CAST(DATEADD(MINUTE, -${shiftOffsetMin}, @now) AS DATE) AS DATETIME));
    DECLARE @end_date DATETIME = @now;
    DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -24, @start_date);
    DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);
    WITH [base_alarm] AS (
      SELECT
        [mc_no],
        [occurred] AS [occurred_start],
        [mc_status]
      FROM ${alarmTable}
      WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1
    ),
    [with_pairing] AS (
      SELECT *,
        ISNULL(LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]), @end_date) AS [occurred_end]
      FROM [base_alarm]
    ),
    [set_time] AS (
      SELECT 
        [mc_no],
        [mc_status],
        IIF(@start_date BETWEEN [occurred_start] AND [occurred_end], @start_date, [occurred_start]) AS [occurred_start],
        IIF([occurred_end] > @end_date, @end_date, [occurred_end]) AS [occurred_end]
      FROM [with_pairing]
    ),
    [filter_time] AS (
        SELECT *, DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
        FROM [set_time]
        WHERE [occurred_start] >= @start_date
    )
    SELECT
      [mc_no],
      CASE WHEN [mc_status] like 'run%' THEN LEFT([mc_status],3) 
        WHEN [mc_status] like 'plan stop%' THEN LEFT([mc_status],9)
        ELSE [mc_status] 
      END AS [mc_status],
      CASE WHEN [mc_status] like 'run%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_duration],
      CASE WHEN [mc_status] like 'plan stop%' THEN SUM([duration_seconds]) ELSE 0 END AS [sum_planstop_duration],
      DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
    FROM [filter_time]
    WHERE [mc_status] like 'run%' OR [mc_status] like 'plan stop%'
    GROUP BY [mc_no], [mc_status]
  `

  return query;
};

module.exports = { buildRunningTimeSql };