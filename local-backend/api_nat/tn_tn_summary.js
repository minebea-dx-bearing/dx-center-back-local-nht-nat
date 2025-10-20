const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment");
const { prepareRealtimeData, getMachineData, queryCurrentRunningTime } = require("./tn_tn_realtime");

const processChartData = (rawData, dataKey) => {
  const dailyTotals = rawData.reduce((acc, item) => {
    const date = item.working_date;
    if (!acc[date]) acc[date] = 0;
    acc[date] += item[dataKey] || 0;
    return acc;
  }, {});
  const sortedDates = Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b));
  const xAxisData = sortedDates.map((date) => moment(date).format("YYYY-MM-DD"));
  const seriesData = sortedDates.map((date) => dailyTotals[date]);
  return { xAxisData, seriesData };
};

const calculateSummary = (dataForToday) => {
  // ... โค้ดฟังก์ชัน reduce เดิมของคุณ ...
  const summary = dataForToday.reduce((acc, item) => {
    const type = item.type;
    if (!acc[type]) {
      acc[type] = {
        total_prod: 0,
        total_drop: 0,
        total_reject: 0,
        total_adjust: 0,
        total_opn: 0,
        latest_registered: item.latest_registered,
        unique_machines: new Set(),
      };
    }
    acc[type].total_prod += item.total_prod;
    acc[type].total_drop += item.total_drop;
    acc[type].total_reject += item.total_reject;
    acc[type].total_adjust += item.total_adjust;
    acc[type].total_opn += item.opn;
    acc[type].unique_machines.add(item.mc_no);
    if (item.latest_registered > acc[type].latest_registered) {
      acc[type].latest_registered = item.latest_registered;
    }
    return acc;
  }, {});

  for (const type in summary) {
    const machine_count = summary[type].unique_machines.size;
    summary[type].machine_count = machine_count;
    summary[type].average_opn = machine_count > 0 ? summary[type].total_opn / machine_count : 0;
    delete summary[type].unique_machines;
    delete summary[type].total_opn;
  }
  return summary;
};

router.post("/data", async (req, res) => {
  let { dateQuery } = req.body;
  try {
    const currentWorkingDate = moment().subtract(6, "hours").format("YYYY-MM-DD");
    const isToday = dateQuery === currentWorkingDate;

    const historicalResponse = await dbms.query(
      `
          DECLARE @select_date DATE = '${dateQuery}';

          -- เริ่มต้นวันแรกของเดือนเดียวกับ select_date เวลา 05:50:00
          DECLARE @start_date DATETIME = DATEADD(MINUTE, 50, DATEADD(HOUR, 5, CAST(DATEFROMPARTS(YEAR(@select_date), MONTH(@select_date), 1) AS DATETIME)));
          -- วันถัดไปของ select_date เวลา 05:10:00
          DECLARE @end_date DATETIME = DATEADD(MINUTE, 10, DATEADD(HOUR, 5, CAST(DATEADD(DAY, 1, @select_date) AS DATETIME)));

          DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
          DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);

          WITH cte AS (
              SELECT
                  [registered],
              CASE 
                      WHEN DATEPART(HOUR, [registered]) < 6 THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
                      ELSE CONVERT(date, [registered])
                  END AS [working_date],
                  [mc_no],
                  [prod_pos4],
                  LAG([prod_pos4]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_prod_pos4],
                  [prod_pos6],
                  LAG([prod_pos6]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_prod_pos6],
              [prod_drop_pos4],
                  LAG([prod_drop_pos4]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_prod_drop_pos4],
              [prod_drop_pos6],
                  LAG([prod_drop_pos6]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_prod_drop_pos6],
              [total_reject],
                  LAG([total_reject]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_total_reject],
              [total_adjust],
                  LAG([total_adjust]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_total_adjust]
              FROM [nat_mc_mcshop_tn].[dbo].[DATA_PRODUCTION_TN]
              WHERE [registered] BETWEEN @start_date AND @end_date
          ),
          cal_diff AS (
            SELECT
              [working_date],
              [mc_no],
              MAX([registered]) AS latest_registered,
              SUM(
                CASE 
                  WHEN prev_prod_pos4 IS NULL THEN 0
                  WHEN [prod_pos4] < prev_prod_pos4 THEN [prod_pos4]
                  ELSE [prod_pos4] - prev_prod_pos4
                END
              ) AS total_prod_pos4,
              SUM(
                CASE 
                  WHEN prev_prod_pos6 IS NULL THEN 0
                  WHEN [prod_pos6] < prev_prod_pos6 THEN [prod_pos6]
                  ELSE [prod_pos6] - prev_prod_pos6
                END
              ) AS total_prod_pos6,
              SUM(
                CASE 
                  WHEN prev_prod_drop_pos4 IS NULL THEN 0
                  WHEN [prod_drop_pos4] < prev_prod_drop_pos4 THEN [prod_drop_pos4]
                  ELSE [prod_drop_pos4] - prev_prod_drop_pos4
                END
              ) AS total_drop_pos4,
              SUM(
                CASE 
                  WHEN prev_prod_drop_pos6 IS NULL THEN 0
                  WHEN [prod_drop_pos6] < prev_prod_drop_pos6 THEN [prod_drop_pos6]
                  ELSE [prod_drop_pos6] - prev_prod_drop_pos6
                END
              ) AS total_drop_pos6,
              SUM(
                CASE 
                  WHEN prev_total_reject IS NULL THEN 0
                  WHEN [total_reject] < prev_total_reject THEN [total_reject]
                  ELSE [total_reject] - prev_total_reject
                END
              ) AS total_reject,
              SUM(
                CASE 
                  WHEN prev_total_adjust IS NULL THEN 0
                  WHEN [total_adjust] < prev_total_adjust THEN [total_adjust]
                  ELSE [total_adjust] - prev_total_adjust
                END
              ) AS total_adjust
            FROM cte
            GROUP BY [working_date], [mc_no]
          ),
          [base_alarm] AS (
              SELECT
                  [mc_no],
              CAST(CONVERT(VARCHAR(19), [occurred], 120) AS DATETIME) AS [occurred],
                  [alarm],
                  CASE
                      WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1)
                      ELSE [alarm]
                  END AS [alarm_base],
                  CASE
                      WHEN RIGHT([alarm], 1) = '_' THEN 'after'
                      ELSE 'before'
                  END AS [alarm_type]
              FROM [nat_mc_mcshop_tn].[dbo].[DATA_ALARMLIS_TN]
              WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND [alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_'
          ),
          [with_pairing] AS (
              SELECT *,
                  ISNULL(
                  LEAD([occurred]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]),
                  @end_date
              ) AS [occurred_next],
              ISNULL(
                  LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]),
                  'after'
              ) AS [next_type]
              FROM [base_alarm]
          ),
          [paired_alarms] AS (
              SELECT
                  [mc_no],
                  [alarm_base],
              CASE
                  WHEN [occurred] < @start_date THEN CAST(@start_date AS datetime)
                  ELSE [occurred]
              END AS [occurred_start],
              CASE
                  WHEN [occurred_next] > @end_date THEN CAST(@end_date AS datetime)
                  ELSE [occurred_next]
              END AS [occurred_end]
              FROM [with_pairing]
              WHERE [alarm_type] = 'before' AND [next_type] = 'after'
          ),
          [filter_time] AS (
              SELECT
              *,
              DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds],
            CASE 
                  WHEN DATEPART(HOUR, [occurred_start]) < 6 THEN CONVERT(date, DATEADD(DAY, -1, [occurred_start]))
                  ELSE CONVERT(date, [occurred_start])
              END AS [working_date]
              FROM [paired_alarms]
              WHERE [occurred_end] > [occurred_start]
          ),
          [sum_duration] AS (
            SELECT
              [working_date],
              [mc_no],
              SUM([duration_seconds]) AS [sum_duration],
              86400 AS [total_time]
            FROM [filter_time]
            GROUP BY [working_date], [mc_no]
          )
          SELECT
            [cal_diff].[working_date],
            [cal_diff].[mc_no],
            [latest_registered],
            [total_prod_pos4],
            [total_prod_pos6],
            [total_drop_pos4],
            [total_drop_pos6],
            [total_prod_pos4] + [total_prod_pos6] AS [total_prod],
            [total_drop_pos4] + [total_drop_pos6] AS [total_drop],
            [total_reject],
            [total_adjust],
            [part_no],
            CASE
              WHEN LEFT([part_no], 1) = 1 THEN 'OUTER'
              WHEN LEFT([part_no], 1) = 2 THEN 'INNER'
              ELSE 'UNKNOWN'
              END AS [type],
            ISNULL([sum_duration], 0) AS [sum_duration],
            86400 AS [total_time],
            CAST(ISNULL([sum_duration], 0) * 100.0 / 86400 AS DECIMAL(18, 2)) AS [opn]
          FROM cal_diff
          LEFT JOIN [nat_mc_mcshop_tn].[dbo].[mc_running_model]
          ON cal_diff.[mc_no] = [mc_running_model].[mc_no]
          LEFT JOIN [sum_duration]
          ON cal_diff.[mc_no] = [sum_duration].[mc_no] AND cal_diff.[working_date] = [sum_duration].[working_date]
      `
    );

    let historicalData = historicalResponse[1] > 0 ? historicalResponse[0] : [];
    let finalData = historicalData;

    if (isToday) {
      console.log("Date is today. Fetching real-time data...");
      try {
        const currentRunningTime = await queryCurrentRunningTime();
        const realtimeCache = getMachineData();
        const realtimeProcessedData = prepareRealtimeData(realtimeCache, currentRunningTime);
        const responsePartNo = await dbms.query(
          `
              WITH Latest AS (
                SELECT
                  [mc_no], [part_no],
                  ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
                FROM [nat_mc_mcshop_tn].[dbo].[mc_running_model]
              )
              SELECT [mc_no], [part_no] FROM Latest WHERE rn = 1;
          `
        );
        const partNoMap = new Map(responsePartNo[0].map((item) => [item.mc_no.toUpperCase(), item.part_no]));

        const realtimeDataFinal = realtimeProcessedData.map((item) => {
          const part_no = partNoMap.get(item.mc_no.toUpperCase()) || "unknown";
          let type = "unknown";
          if (part_no !== "unknown") {
            if (part_no[0] === "1") type = "OUTER";
            else if (part_no[0] === "2") type = "INNER";
          }
          return {
            ...item,
            working_date: currentWorkingDate,
            latest_registered: item.updated_at,
            total_prod_pos4: item.prod_pos4 || 0,
            total_prod_pos6: item.prod_pos6 || 0,
            total_drop_pos4: item.prod_drop_pos4 || 0,
            total_drop_pos6: item.prod_drop_pos6 || 0,
            total_prod: (item.prod_pos4 || 0) + (item.prod_pos6 || 0),
            total_drop: (item.prod_drop_pos4 || 0) + (item.prod_drop_pos6 || 0),
            part_no,
            type,
          };
        });

        const pastData = historicalData.filter((item) => item.working_date !== currentWorkingDate);
        finalData = [...pastData, ...realtimeDataFinal];
      } catch (apiError) {
        console.error("Failed to fetch or process real-time data:", apiError.message);
      }
    }

    if (finalData.length === 0) {
      return res.json({ success: false, message: "Don't have data in range" });
    }

    const prod_daily = processChartData(finalData, "total_prod");
    const drop_daily = processChartData(finalData, "total_drop");

    const dataForSummary = finalData.filter((item) => item.working_date === dateQuery);
    const summaryByType = calculateSummary(dataForSummary);

    const data_table = finalData.map((item) => ({
      ...item,
      mc_no: item.mc_no.toUpperCase(),
    }));

    res.json({
      success: true,
      summaryByType,
      prod_daily,
      drop_daily,
      data_table,
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
