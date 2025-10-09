const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const mqtt = require("mqtt");
const moment = require("moment");

// In-Memory Cache สำหรับเก็บข้อมูลทั้งหมด
let machineData = {};

// --- Configurations ---
const MQTT_SERVER = "10.128.16.110";
const PORT = "1883";
const DATABASE_PROD = "[nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD]";
const DATABASE_ALARM = "[nat_mc_mcshop_2gd].[dbo].[DATA_ALARMLIS_2GD]";

const master_mc_no = async () => {
  try {
    const mc_no = await dbms.query(
      `
        WITH LatestProduction AS (
            SELECT
            [registered]
            ,[mc_no]
            ,[process]
            ,[rssi]
            ,[model]
            ,[spec]
            ,[avgct]
            ,[eachct]
            ,[yieldrt]
            ,[ng_p]
            ,[ng_n]
            ,[tng]
            ,[prod_total]
            ,[utilization]
            ,[utl_total]
            ,[prod_s1]
            ,[prod_s2]
            ,[prod_s3]
            ,[cth1]
            ,[cth2]
            ,[idh1]
            ,[idh2]
            ,[yield_ok]
            ,[yield_ng_pos]
            ,[yield_ng_neg]
            ,[time_full]
            ,[time_full1]
            ,[time_wait]
            ,[time_wait1]
            ,[time_run]
            ,[time_run1]
            ,[time_alarm]
            ,[time_alarm1]
            ,[time_worn]
            ,[time_worn1]
            ,[time_warm]
            ,[time_warm1]
            ,[time_dress]
            ,[time_dress1]
            ,[time_other]
            ,[time_other1]
            ,[idl]
            ,[hour]
            ,[min]
            ,ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_PROD}
            WHERE
                [registered] >= DATEADD(day, -3, GETDATE()) AND [mc_no] LIKE 'or%h'
        ),
        LatestAlarm AS (
            SELECT
            [mc_no]
            ,[alarm]
            ,[occurred]
            ,ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [occurred] DESC) AS rn
            FROM ${DATABASE_ALARM}
            WHERE
                UPPER([alarm]) LIKE '%RUN%'
                AND [occurred] >= DATEADD(day, -3, GETDATE()) AND [mc_no] LIKE 'or%h'
        )
        SELECT 
          p.[registered]
          ,p.[mc_no]
          ,p.[process]
          ,p.[rssi]
          ,p.[model]
          ,p.[spec]
          ,p.[avgct]
          ,p.[eachct]
          ,p.[yieldrt]
          ,p.[ng_p]
          ,p.[ng_n]
          ,p.[tng]
          ,p.[prod_total]
          ,p.[utilization]
          ,p.[utl_total]
          ,p.[prod_s1]
          ,p.[prod_s2]
          ,p.[prod_s3]
          ,p.[cth1]
          ,p.[cth2]
          ,p.[idh1]
          ,p.[idh2]
          ,p.[yield_ok]
          ,p.[yield_ng_pos]
          ,p.[yield_ng_neg]
          ,p.[time_full]
          ,p.[time_full1]
          ,p.[time_wait]
          ,p.[time_wait1]
          ,p.[time_run]
          ,p.[time_run1]
          ,p.[time_alarm]
          ,p.[time_alarm1]
          ,p.[time_worn]
          ,p.[time_worn1]
          ,p.[time_warm]
          ,p.[time_warm1]
          ,p.[time_dress]
          ,p.[time_dress1]
          ,p.[time_other]
          ,p.[time_other1]
          ,p.[idl]
          ,p.[hour]
          ,p.[min]
          ,ISNULL(a.[alarm], 'no data') AS [alarm]
          ,a.[occurred]
        FROM LatestProduction p
        LEFT JOIN LatestAlarm a 
            ON p.[mc_no] = a.[mc_no]
            AND a.rn = 1
        WHERE p.rn = 1
        ORDER BY p.[mc_no];
    `
    );

    return mc_no[0];
  } catch (error) {
    console.error("Database Query Error: ", error);
    return [];
  }
};

const reloadMasterData = async () => {
  console.log(`[${moment().format("HH:mm:ss")}] Reloading master data from SQL...`);
  try {
    const sqlDataArray = await master_mc_no();
    if (!sqlDataArray) return;

    const sqlDataMap = new Map(sqlDataArray.map((item) => [item.mc_no, item]));

    // 1. เพิ่ม/อัปเดตเครื่องจักรจาก SQL
    for (const row of sqlDataArray) {
      if (machineData.hasOwnProperty(row.mc_no)) {
        machineData[row.mc_no] = {
          ...machineData[row.mc_no],
          ...row,
        };
      } else {
        machineData[row.mc_no] = { ...row, source: "SQL" };
      }
    }

    for (const mc_no in machineData) {
      if (!sqlDataMap.has(mc_no)) {
        console.log(`Machine removed from SQL: ${mc_no}. Deleting from cache.`);
        delete machineData[mc_no];
      }
    }

    console.log(`Master data reloaded. Total machines in cache: ${Object.keys(machineData).length}`);
  } catch (error) {
    console.error("Failed to reload master data:", error);
  }
};

// MQTT connect
const client = mqtt.connect(`mqtt://${MQTT_SERVER}:${PORT}`);

client.on("connect", () => {
  console.log("MQTT Connected");
  client.subscribe("#", (err) => {
    if (!err) console.log("Subscribed to all topics (#)");
  });
});

client.on("message", (topic, message) => {
  try {
    const mc_no = topic.split("/").pop();

    if (machineData.hasOwnProperty(mc_no)) {
      const mqttData = JSON.parse(message.toString());

      machineData[mc_no] = {
        ...machineData[mc_no],
        ...mqttData,
        updated_at: moment().format("YYYY-MM-DD HH:mm:ss"),
        source: "MQTT",
      };
    }
  } catch (error) {
    console.error("MQTT Message Error: ", error);
  }
});

router.get("/machines", async (req, res) => {
  try {
    let runningTime = await dbms.query(
      `
        DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} 07:00:00';
        DECLARE @end_date DATETIME = GETDATE();
        DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
        DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);

        WITH [base_alarm] AS (
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
            FROM ${DATABASE_ALARM}
            WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND ([alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_') AND [mc_no] LIKE 'or%h'
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
            DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
          FROM [paired_alarms]
          WHERE [occurred_end] > [occurred_start]
        )

        SELECT
          [mc_no],
          SUM([duration_seconds]) AS [sum_duration],
          DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
        FROM [filter_time]
        GROUP BY [mc_no]
      `
    );

    if (runningTime[1] > 0) {
      runningTime = runningTime[0];
    } else {
      runningTime = [];
    }

    const dataArray = Object.values(machineData).map((item) => {
      let status_alarm;
      if (item.broker === 0 || moment().diff(moment(item.occurred), "minutes") > 10 || item.occurred === null) {
        status_alarm = "SIGNAL LOSE";
      } else if (item.alarm.toUpperCase().includes("RUN") && item.alarm.slice(-1) !== "_") {
        status_alarm = "RUNNING";
      } else if (item.alarm?.slice(-1) === "_") {
        status_alarm = "STOP";
      } else {
        status_alarm = item.alarm;
      }

      const runInfo = runningTime.find((rt) => rt.mc_no === item.mc_no);

      let opn = 0;
      let sum_run = 0;
      let total_time = 0;

      if (runInfo) {
        sum_run = runInfo.sum_duration;
        total_time = runInfo.total_time;
        if (total_time > 0) {
          opn = Number(((sum_run / total_time) * 100).toFixed(2));
        }
      }

      // target ชั่วคราว
      let target = 0;
      let target_ct = 0;

      // เปลี่ยนชื่อใหม่เหมือนๆกัน
      const prod_ok = item.prod_total || 0;
      const prod_ng = item.ng_p + item.ng_n + item.tng || 0;
      const cycle_t = item.cth2 / 100 || 0;

      return {
        ...item,
        mc_no: item.mc_no.toUpperCase(),
        yield_per: prod_ok + prod_ng === 0 ? 0 : Number(((prod_ok / (prod_ok + prod_ng)) * 100).toFixed(2)),
        status_alarm,
        prod_ok,
        prod_ng,
        cycle_t,
        sum_run: runInfo?.sum_duration || 0,
        total_time: runInfo?.total_time || 0,
        opn,
        target,
        target_ct,
      };
    });

    const summary = dataArray.reduce(
      (acc, item) => {
        acc.total_target += item.target || 0;
        acc.total_ok += item.prod_ok || 0;
        acc.total_cycle_t += item.cycle_t || 0;
        acc.total_opn += item.opn || 0;
        acc.count += 1;
        return acc;
      },
      { total_target: 0, total_ok: 0, total_cycle_t: 0, total_opn: 0, count: 0 }
    );

    const resultSummary = {
      sum_target: summary.total_target,
      sum_daily_ok: summary.total_ok,
      avg_cycle_t: summary.count > 0 ? Number((summary.total_cycle_t / summary.count).toFixed(2)) : 0,
      avg_opn: summary.count > 0 ? Number((summary.total_opn / summary.count).toFixed(2)) : 0,
    };

    res.json({
      success: true,
      data: dataArray,
      resultSummary,
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

reloadMasterData();

setInterval(reloadMasterData, 300000);

module.exports = router;
