const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment");

const time_start = "06:10";

router.get("/select", async (req, res) => {
  try {
    const response_select = await dbms.query(
      `
          SELECT 'ALL' AS [mc_no]

          UNION ALL

          SELECT DISTINCT
              UPPER([mc_no]) AS [mc_no]
          FROM [nat_mc_assy_arp].[dbo].[DATA_PRODUCTION_ARP]
          ORDER BY [mc_no]
      `
    );
    res.json({
      success: true,
      data_select: response_select[0],
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.post("/data", async (req, res) => {
  let { dateQuery, mcNoQuery = "ALL" } = req.body;
  const nextDay = moment(dateQuery).add(1, "day").format("YYYY-MM-DD");

  let queryWhere1;
  let queryWhere2;
  if (mcNoQuery === "ALL") {
    queryWhere1 = "";
    queryWhere2 = "";
  } else {
    queryWhere1 = `AND [mc_no] = '${mcNoQuery}'`;
    queryWhere2 = `WHERE [mc_no] = '${mcNoQuery}'`;
  }

  try {
    const response_prod = await dbms.query(
      `
        DECLARE @start_date DATETIME = '${dateQuery} ${time_start}';
        DECLARE @TargetEndDate DATETIME = '${nextDay} ${time_start}';
        DECLARE @end_date DATETIME = CASE
        WHEN @TargetEndDate > GETDATE()
        THEN GETDATE()
        ELSE @TargetEndDate
        END;

        WITH cte AS (
            SELECT
                [registered],
            CASE 
                WHEN DATEPART(HOUR, [registered]) < 7 THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
                ELSE CONVERT(date, [registered])
            END AS [working_date],
            UPPER([mc_no]) AS [mc_no],
          [cycle_t] / 100 AS [cycle_time],
            [daily_ok],
            LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_daily_ok],
          [daily_ng],
            LAG([daily_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_daily_ng]
            FROM [nat_mc_assy_arp].[dbo].[DATA_PRODUCTION_ARP]
            WHERE [registered] BETWEEN @start_date AND @end_date ${queryWhere1}
        ),
        [master_target] AS (
          	SELECT
              UPPER([mc_no]) AS [mc_no],
              [part_no],
              [target_ct],
              [target_utl],
              [target_yield],
              [target_special],
              [ring_factor],
              ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM [nat_mc_assy_arp].[dbo].[DATA_MASTER_ARP]
        ),
        [sum_data] AS (
            SELECT
                [working_date],
                [mc_no],
                MAX([registered]) AS latest_registered,
                ROUND(AVG([cycle_time]), 2) AS [avg_ct],
                SUM(
                CASE 
                  WHEN [prev_daily_ok] IS NULL THEN 0
                  WHEN [daily_ok] < [prev_daily_ok] THEN [daily_ok]
                  ELSE [daily_ok] - [prev_daily_ok]
                END
                ) AS [total_daily_ok],
                SUM(
                CASE 
                  WHEN [prev_daily_ng] IS NULL THEN 0
                  WHEN [daily_ng] < [prev_daily_ng] THEN [daily_ng]
                  ELSE [daily_ng] - [prev_daily_ng]
                END
                ) AS [total_daily_ng]
            FROM cte
            GROUP BY [working_date], [mc_no]
        )
        SELECT
            [sum_data].*,
            [sum_data].[total_daily_ok] + [sum_data].[total_daily_ng] AS [total_prod],
            ISNULL([master_target].[part_no], 0) AS [part_no],
            ISNULL([master_target].[target_ct], 0) AS [target_ct],
            ISNULL([master_target].[target_utl], 0) AS [target_utl],
            ISNULL([master_target].[target_yield], 100) AS [target_yield],
            ISNULL([master_target].[target_special], 0) AS [target_special],
            ISNULL([master_target].[ring_factor], 1) AS [ring_factor]
        FROM [sum_data]
        LEFT JOIN [master_target]
        ON [master_target].[mc_no] = [sum_data].[mc_no] AND [master_target].[rn] = 1
      `
    );

    const response_alarm = await dbms.query(
      `
        DECLARE @start_date DATETIME = '${dateQuery} ${time_start}';
        DECLARE @TargetEndDate DATETIME = '${nextDay} ${time_start}';
        DECLARE @end_date DATETIME = CASE
        WHEN @TargetEndDate > GETDATE()
        THEN GETDATE()
        ELSE @TargetEndDate
        END;
        DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);    -- เวลาที่ต้องการลบไป 2hr เพื่อดึง alarm ตัวก่อนหน้า --
        DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);        -- เวลาที่ต้องการบวกไป 2hr เพื่อดึง alarm ตัวหลัง --

        WITH [base_alarm] AS (
            -- เรียก data ทั้งหมด ก่อนและหลัง 1hr --
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
            FROM [nat_mc_assy_arp].[dbo].[DATA_ALARMLIS_ARP]
            WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1
        ),
        [with_pairing] AS (
            -- จับคู่ alarm กับ alarm_ --
            SELECT *,
                LEAD([occurred]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]) AS [occurred_next],
                LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]) AS [next_type]
            FROM [base_alarm]
        ),
        [paired_alarms] AS (
            -- filter เฉพาะตัวที่มี alarm , alarm_ และ check ตัว alarm ที่เกิดซ้อนอยู่ใน alarm อีกตัว --
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
            FROM [nat_mc_assy_arp].[dbo].[MONITOR_IOT]
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
            -- เก็บเฉพาะแถวที่ broker = 0 แล้วทำ running group id สำหรับช่วงต่อเนื่อง
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
            -- ตัดตัวที่เป็น alarm ซ้อนใน alarm อีกตัวออกและเพิ่มเวลาก่อนและหลังเพื่อคำนวณ --
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
            -- filter เอาเฉพาะเวลาที่ต้องการ , ถ้า alarm = mc_run แล้วเวลาซ้อนกับ alarm ตัวอื่นจะตัดเวลา alarm ตัวนั้นออก , ถ้าเป็น alarm1 เหลื่อม alarm2 จะตัดเวลา alarm1 ออกตามที่เหลื่อม --
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
            -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
            SELECT
                [mc_no],
                'STOP' AS [status_alarm],
                [occurred_end] AS [occurred_start],
                [next_occurred] AS [occurred_end]
            FROM [edit_occurred]
            WHERE [next_gap_seconds] > 0
        ),
        [insert_stop_end] AS (
            -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
            SELECT
                [mc_no],
                'STOP' AS [status_alarm],
                [occurred_end] AS [occurred_start],
                @end_date AS [occurred_end]
            FROM [edit_occurred]
            WHERE [next_gap_seconds] IS NULL
        ),
        [insert_stop_start] AS (
            -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
            SELECT
                [mc_no],
                'STOP' AS [status_alarm],
                @start_date AS [occurred_start],
                [new_occurred_start] AS [occurred_end]
            FROM [edit_occurred]
            WHERE [previous_gap_seconds] IS NULL
        ),
        [combine_result] AS (
            -- รวม alarm ทั้งหมดกับ STOP เข้าด้วยกัน --
            SELECT UPPER([mc_no]) AS [mc_no], UPPER([status_alarm]) AS [status_alarm], [new_occurred_start] AS [occurred_start], [occurred_end] FROM [edit_occurred]
            UNION ALL
            SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop]
          UNION ALL
          SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop_end]
          UNION ALL
          SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop_start]
        ),
        [edit_time_result] AS (
            -- ปัดเวลาให้เท่ากับเวลาที่ต้องการ --
            SELECT
                [mc_no],
                [status_alarm],
                CASE 
                    WHEN [occurred_start] < @start_date THEN CAST(@start_date AS datetime)    -- ปัดเวลาหัวให้เท่ากับเวลาที่ต้องการ --
                    ELSE [occurred_start]
                END AS [occurred_start],
                CASE 
                    WHEN [occurred_end] > @end_date THEN CAST(@end_date AS datetime)    -- ปัดเวลาท้ายให้เท่ากับเวลาที่ต้องการ --
                    ELSE [occurred_end]
                END AS [occurred_end]
            FROM [combine_result]
        ),
        [filter_result] AS (
            -- หลังปัดเวลาเสร็จ filter เอาข้อมูลที่เวลาผิดทิ้ง --
            SELECT * FROM [edit_time_result]
            WHERE
                [occurred_end] > [occurred_start]
        ),
        [sum_data] AS (
          SELECT
            *,
            DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
          FROM [filter_result]
        )
        SELECT
          [mc_no]
          ,[status_alarm]
          ,SUM([duration_seconds]) AS [sum_duration_seconds]
        FROM [sum_data]
        ${queryWhere2}
        GROUP BY [mc_no], [status_alarm]
        ORDER BY [mc_no], [status_alarm]
      `
    );
    let data_prod = response_prod[0].length > 0 ? response_prod[0] : [];
    let data_alarm = response_alarm[0].length > 0 ? response_alarm[0] : [];

    const summary_data = {
      target_prod: 0,
      actual_prod: 0,
      down_time: 0,
      planstop_time: 0,
      avg_utl: 0,
      avg_opn: 0,
      availability: 0,
      performance: 0,
      quality: 0,
      oee: 0,
    };

    let latest_registered = null;
    let chart_data_prod_vs_mc = [];
    let chart_summary_by_status = [];
    let chart_stacked_by_mc = [];

    if (data_prod.length > 0) {
      data_prod = data_prod.map((item_prod) => {
        let running_time = 0;
        let down_time = 0;
        let planstop_time = 0;
        let total_time = 0;

        const filtered_alarms = data_alarm.filter((i) => i.mc_no === item_prod.mc_no);

        const find_alarm_with_type = filtered_alarms.map((item_alarm) => {
          let type;

          if (item_alarm.status_alarm.includes("RUN")) {
            running_time += item_alarm.sum_duration_seconds;
            type = "running";
          } else if (item_alarm.status_alarm === "STOP") {
            planstop_time += item_alarm.sum_duration_seconds;
            type = "planstop";
          } else {
            down_time += item_alarm.sum_duration_seconds;
            type = "downtime";
          }

          return {
            ...item_alarm,
            type: type,
          };
        });

        total_time = running_time + down_time + planstop_time;

        const round_time = moment(time_start, "HH:mm").startOf("hours").format("HH:mm");

        diff_time_stamp = moment(item_prod.latest_registered.toISOString().replace("Z", ""))
          .startOf("hours")
          .diff(moment(`${dateQuery} ${round_time}`), "seconds");

        let target_prod = 0;
        if (item_prod.target_special > 0) {
          target_prod = Number(((item_prod.target_special / 86400) * diff_time_stamp).toFixed(0));
        } else {
          if (item_prod.target_ct === 0) {
            target_prod = 0;
          } else {
            target_prod = Number(
              (
                (diff_time_stamp / item_prod.target_ct) *
                (item_prod.target_utl / 100) *
                (item_prod.target_yield / 100) *
                item_prod.ring_factor
              ).toFixed(0)
            );
          }
        }

        const utl = Number(((item_prod.total_prod / ((diff_time_stamp / item_prod.target_ct) * item_prod.ring_factor)) * 100).toFixed(2)) || 0;
        const opn = Number(((running_time / total_time) * 100).toFixed(2)) || 0;
        const availability = Number(((running_time / (total_time - planstop_time)) * 100).toFixed(2)) || 0;
        const performance = Number(((item_prod.total_prod / ((running_time / item_prod.target_ct) * item_prod.ring_factor)) * 100).toFixed(2)) || 0;
        const quality = Number(((item_prod.total_daily_ok / item_prod.total_prod) * 100).toFixed(2)) || 0;
        const oee = Number(((availability / 100) * (performance / 100) * (quality / 100) * 100).toFixed(2)) || 0;

        summary_data.target_prod += target_prod;
        summary_data.actual_prod += item_prod.total_prod;
        summary_data.down_time += down_time;
        summary_data.planstop_time += planstop_time;

        summary_data.avg_utl += utl;
        summary_data.avg_opn += opn;
        summary_data.availability += availability;
        summary_data.performance += performance;
        summary_data.quality += quality;
        summary_data.oee += oee;

        return {
          ...item_prod,
          running_time,
          down_time,
          planstop_time,
          total_time,
          target_prod,
          utl,
          opn,
          availability,
          performance,
          quality,
          oee,
          find_alarm: find_alarm_with_type,
        };
      });
    }

    const count = data_prod.length;

    summary_data.avg_utl = Number((summary_data.avg_utl / count).toFixed(2));
    summary_data.avg_opn = Number((summary_data.avg_opn / count).toFixed(2));
    summary_data.availability = Number((summary_data.availability / count).toFixed(2));
    summary_data.performance = Number((summary_data.performance / count).toFixed(2));
    summary_data.quality = Number((summary_data.quality / count).toFixed(2));
    summary_data.oee = Number((summary_data.oee / count).toFixed(2));

    latest_registered = moment(
      data_prod.reduce((max, curr) => {
        return curr.latest_registered > max ? curr.latest_registered : max;
      }, data_prod[0].latest_registered)
    )
      .utc()
      .format("YYYY-MM-DD HH:mm:ss");

    chart_data_prod_vs_mc = data_prod.map((item) => {
      return {
        mc_no: item.mc_no,
        total_prod: item.total_prod,
      };
    });

    const summary_status_map = {};
    data_prod.forEach((item_prod) => {
      item_prod.find_alarm.forEach((item_alarm) => {
        if (item_alarm.type !== "running") {
          const status = item_alarm.status_alarm;
          const duration = item_alarm.sum_duration_seconds;
          summary_status_map[status] = (summary_status_map[status] || 0) + duration;
        }
      });
    });

    chart_summary_by_status = Object.keys(summary_status_map)
      .map((statusName) => ({
        status_alarm: statusName,
        total_duration: summary_status_map[statusName],
      }))
      .sort((a, b) => b.total_duration - a.total_duration);

    const legendData = new Set();
    data_prod.forEach((item_prod) => {
      item_prod.find_alarm.forEach((item_alarm) => {
        if (item_alarm.type !== "running") {
          legendData.add(item_alarm.status_alarm);
        }
      });
    });
    const legendArray = Array.from(legendData);

    const xAxisData = data_prod.map((item) => item.mc_no);

    const seriesDataMap = new Map();
    legendArray.forEach((name) => {
      seriesDataMap.set(name, new Array(data_prod.length).fill(0));
    });

    data_prod.forEach((item_prod, index) => {
      item_prod.find_alarm.forEach((item_alarm) => {
        if (item_alarm.type !== "running") {
          const status = item_alarm.status_alarm;
          const duration = item_alarm.sum_duration_seconds;

          const dataArray = seriesDataMap.get(status);
          dataArray[index] += duration;
        }
      });
    });

    const series = legendArray.map((name) => ({
      name: name,
      type: "bar",
      stack: "total",
      emphasis: { focus: "series" },
      data: seriesDataMap.get(name),
    }));

    chart_stacked_by_mc = {
      xAxis: xAxisData,
      legend: legendArray,
      series: series,
    };

    res.json({
      success: true,
      latest_registered,
      summary_data,
      chart_data_prod_vs_mc,
      chart_summary_by_status,
      chart_stacked_by_mc,
      data_table: data_prod,
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
