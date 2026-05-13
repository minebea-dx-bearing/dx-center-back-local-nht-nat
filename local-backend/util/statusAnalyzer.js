// local-backend/util/statusAnalyzer.js
const moment = require("moment-timezone");

const getStatusTimeline = async (dbms, mc_no, date, config) => {
  const { databaseAlarm, databaseIot } = config;
  const dateTomarrow = moment(date).add(1, "day").format("YYYY-MM-DD");
  const startDate = `${date} 07:00`;
  const targetEndDate = `${dateTomarrow} 07:00`;

  const [result] = await dbms.query(
    `
    DECLARE @start_date DATETIME = :startDate;
    DECLARE @TargetEndDate DATETIME = :targetEndDate;
    DECLARE @end_date DATETIME = CASE
    WHEN @TargetEndDate > GETDATE()
    THEN GETDATE()
    ELSE @TargetEndDate
    END;
    DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
    DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);

    WITH [base_alarm] AS (
        SELECT
            [mc_no],
            [occurred],
            [alarm],
            CASE
                WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1)
                ELSE [alarm]
            END AS [status_alarm],
            CASE
                WHEN RIGHT([alarm], 1) = '_' THEN 'after'
                ELSE 'before'
            END AS [alarm_type]
        FROM ${databaseAlarm}
        WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1
    ),
    [with_pairing] AS (
        SELECT *,
            ISNULL(LEAD([occurred]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]), @end_date) AS [occurred_next],
            ISNULL(LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]), 'after') AS [next_type]
        FROM [base_alarm]
    ),
    [paired_alarms] AS (
        SELECT
            [mc_no],
            [status_alarm],
            [occurred] AS [occurred_start],
            [occurred_next] AS [occurred_end]
        FROM [with_pairing]
        WHERE [alarm_type] = 'before' AND [next_type] = 'after'
    ),
    [base_monitor_iot] AS (
        SELECT
            [mc_no],
            [registered],
            CAST(broker AS FLOAT) AS [broker_f]
        FROM ${databaseIot}
        WHERE registered BETWEEN @start_date_p1 AND @end_date_p1
    ),
    [mark] AS (
        SELECT
            [mc_no],
            [registered],
            [broker_f],
            CASE WHEN [broker_f] = 0 THEN 1 ELSE 0 END AS [is_zero],
            LAG(CASE WHEN [broker_f] = 0 THEN 1 ELSE 0 END)
                OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_is_zero],
            LEAD(CASE WHEN [broker_f] = 0 THEN 1 ELSE 0 END)
                OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [next_is_zero],
            LEAD([registered])
                OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [next_registered]
        FROM [base_monitor_iot]
    ),
    [flagged] AS (
        SELECT
            *,
            CASE WHEN [is_zero] = 1 AND ISNULL([prev_is_zero],0) = 0 THEN 1 ELSE 0 END AS [start_flag],
            CASE WHEN [is_zero] = 1 AND ISNULL([next_is_zero],0) = 0 THEN 1 ELSE 0 END AS [end_flag]
        FROM [mark]
    ),
    [grpz] AS (
        SELECT
            *,
            SUM(CASE WHEN [start_flag] = 1 THEN 1 ELSE 0 END)
                OVER (PARTITION BY [mc_no] ORDER BY [registered] ROWS UNBOUNDED PRECEDING) AS [grp]
        FROM [flagged]
        WHERE [is_zero] = 1
    ),
    [summary_connection_lose] AS (
        SELECT
        [mc_no],
        'connection lose' AS [status_alarm],
        MIN(registered) AS [occurred_start],
        MAX(CASE WHEN [end_flag] = 1 THEN ISNULL([next_registered], [registered]) END) AS [occurred_end]
        FROM [grpz]
        GROUP BY [mc_no], [grp]
    ),
    [conbine_connection_lose] AS (
        SELECT * FROM [summary_connection_lose]
        UNION ALL
        SELECT * FROM [paired_alarms]
    ),
    [with_max_prev] AS (
        SELECT *,
            MAX([occurred_end]) OVER (
                PARTITION BY [mc_no]
                ORDER BY [occurred_start]
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ) AS [max_prev_end]
        FROM [conbine_connection_lose]
    ),
    [check_duplicate] AS (
        SELECT
            [mc_no],
            [status_alarm],
            [occurred_start],
            [occurred_end],
            CASE
                WHEN [max_prev_end] IS NOT NULL AND [occurred_end] <= [max_prev_end] THEN 1
                ELSE 0
            END AS [duplicate]
        FROM [with_max_prev]
    ),
    [clamped_alarms] AS (
        SELECT
            [mc_no],
            [status_alarm],
            [occurred_start],
            [occurred_end],
            LAG([status_alarm]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_end]) AS [previous_alarm],
            LAG([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_end]) AS [previous_occurred],
            DATEDIFF(SECOND, LAG([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_end]), [occurred_start]) AS [previous_gap_seconds],
            LEAD([status_alarm]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [next_alarm],
            LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [next_occurred],
            DATEDIFF(SECOND, [occurred_end], LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start])) AS [next_gap_seconds]
        FROM [check_duplicate]
        WHERE [duplicate] = 0
    ),
    [edit_occurred] AS (
        SELECT
            *,
            CASE
                WHEN [previous_gap_seconds] < 0 AND [previous_alarm] = 'mc_run' THEN [previous_occurred]
                WHEN [previous_gap_seconds] < 0 THEN [previous_occurred]
                ELSE [occurred_start]
            END AS [new_occurred_start]
        FROM [clamped_alarms]
    ),
    [insert_stop] AS (
        SELECT
            [mc_no],
            'STOP' AS [status_alarm],
            [occurred_end] AS [occurred_start],
            [next_occurred] AS [occurred_end]
        FROM [edit_occurred]
        WHERE [next_gap_seconds] > 0
    ),
    [insert_stop_end] AS (
        SELECT
            [mc_no],
            'STOP' AS [status_alarm],
            [occurred_end] AS [occurred_start],
            @end_date AS [occurred_end]
        FROM [edit_occurred]
        WHERE [next_gap_seconds] IS NULL
    ),
    [insert_stop_start] AS (
        SELECT
            [mc_no],
            'STOP' AS [status_alarm],
            @start_date AS [occurred_start],
            [new_occurred_start] AS [occurred_end]
        FROM [edit_occurred]
        WHERE [previous_gap_seconds] IS NULL
    ),
    [combine_result] AS (
        SELECT UPPER([mc_no]) AS [mc_no], UPPER([status_alarm]) AS [status_alarm], [new_occurred_start] AS [occurred_start], [occurred_end] FROM [edit_occurred]
        UNION ALL
        SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop]
        UNION ALL
        SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop_end]
        UNION ALL
        SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop_start]
    ),
    [edit_time_result] AS (
        SELECT
            [mc_no],
            [status_alarm],
            CASE
                WHEN [occurred_start] < @start_date THEN CAST(@start_date AS datetime)
                ELSE [occurred_start]
            END AS [occurred_start],
            CASE
                WHEN [occurred_end] > @end_date THEN CAST(@end_date AS datetime)
                ELSE [occurred_end]
            END AS [occurred_end]
        FROM [combine_result]
    ),
    [filter_result] AS (
        SELECT * FROM [edit_time_result]
        WHERE [occurred_end] > [occurred_start]
    )
    SELECT
      *,
      DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
    FROM [filter_result]
    WHERE [mc_no] = :mc_no
    ORDER BY [mc_no], [occurred_start]
    `,
    { replacements: { mc_no, startDate, targetEndDate } }
  );

  return result;
};

module.exports = { getStatusTimeline };
