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
const DATABASE_PROD = "[nat_mc_mcshop_tn].[dbo].[DATA_PRODUCTION_TN]";
const DATABASE_ALARM = "[nat_mc_mcshop_tn].[dbo].[DATA_ALARMLIS_TN]";

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
            ,[prod_pos4]
            ,[prod_pos6]
            ,[prod_drop_pos4]
            ,[prod_drop_pos6]
            ,[machine_utl]
            ,[prod_utl]
            ,[cycle_time]
            ,[wait_qa_check]
            ,[prod_ok]
            ,[total_reject]
            ,[line_reject]
            ,[qa_reject]
            ,[total_adjust]
            ,[prod_total_1r]
            ,[forming_1r]
            ,[facing_bit_1r]
            ,[recess3_1r]
            ,[cutoff_1_1r]
            ,[recess5_1r]
            ,[cutoff_2_1r]
            ,[drill_1r]
            ,[partcheck_1r]
            ,[prod_bar_1r]
            ,[od_bit_1r]
            ,[prod_total_2r]
            ,[forming_2r]
            ,[drill_2r]
            ,[center_drill_2r]
            ,[facing_2r]
            ,[reamer_2r]
            ,[recess_2r]
            ,[cutoff_2r]
            ,[partcheck_2r]
            ,[prod_bar_2r]
            ,[time_hr]
            ,[time_min]
            ,ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_PROD}
            WHERE
                [registered] >= DATEADD(day, -3, GETDATE())
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
                AND [occurred] >= DATEADD(day, -3, GETDATE())
        )
        SELECT 
          p.[registered]
          ,p.[mc_no]
          ,p.[process]
          ,p.[rssi]
          ,p.[model]
          ,p.[spec]
          ,p.[prod_pos4]
          ,p.[prod_pos6]
          ,p.[prod_drop_pos4]
          ,p.[prod_drop_pos6]
          ,p.[machine_utl]
          ,p.[prod_utl]
          ,p.[cycle_time]
          ,p.[wait_qa_check]
          ,p.[prod_ok]
          ,p.[total_reject]
          ,p.[line_reject]
          ,p.[qa_reject]
          ,p.[total_adjust]
          ,p.[prod_total_1r]
          ,p.[forming_1r]
          ,p.[facing_bit_1r]
          ,p.[recess3_1r]
          ,p.[cutoff_1_1r]
          ,p.[recess5_1r]
          ,p.[cutoff_2_1r]
          ,p.[drill_1r]
          ,p.[partcheck_1r]
          ,p.[prod_bar_1r]
          ,p.[od_bit_1r]
          ,p.[prod_total_2r]
          ,p.[forming_2r]
          ,p.[drill_2r]
          ,p.[center_drill_2r]
          ,p.[facing_2r]
          ,p.[reamer_2r]
          ,p.[recess_2r]
          ,p.[cutoff_2r]
          ,p.[partcheck_2r]
          ,p.[prod_bar_2r]
          ,p.[time_hr]
          ,p.[time_min]
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

const queryCurrentRunningTime = async () => {
  const result = await dbms.query(
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
  return result[1] > 0 ? result[0] : [];
};

const prepareRealtimeData = (currentMachineData, runningTimeData) => {
  return Object.values(currentMachineData).map((item) => {
    let status_alarm;
    if (!item.occurred || moment().diff(moment(item.occurred), "minutes") > 10) {
      status_alarm = "SIGNAL LOSE";
    } else if (item.alarm?.toUpperCase().includes("RUN") && !item.alarm.endsWith("_")) {
      status_alarm = "RUNNING";
    } else if (item.alarm?.endsWith("_")) {
      status_alarm = "STOP";
    } else {
      status_alarm = item.alarm;
    }

    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    // target ชั่วคราว
    let target = 0;
    let target_ct = 0;

    // เปลี่ยนชื่อใหม่เหมือนๆกัน
    const prod_ok = item.prod_pos4 + item.prod_pos6 || 0;
    const prod_ng = 0;
    const cycle_t = item.cycle_time / 100 || 0;

    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
      status_alarm,
      prod_ok,
      prod_ng,
      cycle_t,
      sum_run,
      total_time,
      opn,
    };
  });
};

// router.get("/machines", async (req, res) => {
//   try {
//     let runningTimeResult = await dbms.query(
//       `
//         DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} 07:00:00';
//         DECLARE @end_date DATETIME = GETDATE();
//         DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
//         DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);

//         WITH [base_alarm] AS (
//             SELECT
//                 [mc_no],
//             CAST(CONVERT(VARCHAR(19), [occurred], 120) AS DATETIME) AS [occurred],
//                 [alarm],
//                 CASE
//                     WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1)
//                     ELSE [alarm]
//                 END AS [alarm_base],
//                 CASE
//                     WHEN RIGHT([alarm], 1) = '_' THEN 'after'
//                     ELSE 'before'
//                 END AS [alarm_type]
//             FROM ${DATABASE_ALARM}
//             WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND [alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_'
//         ),
//         [with_pairing] AS (
//             SELECT *,
//                 ISNULL(
//                 LEAD([occurred]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]),
//                 @end_date
//             ) AS [occurred_next],
//             ISNULL(
//                 LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]),
//                 'after'
//             ) AS [next_type]
//             FROM [base_alarm]
//         ),
//         [paired_alarms] AS (
//             SELECT
//                 [mc_no],
//                 [alarm_base],
//             CASE
//               WHEN [occurred] < @start_date THEN CAST(@start_date AS datetime)
//               ELSE [occurred]
//             END AS [occurred_start],
//             CASE
//               WHEN [occurred_next] > @end_date THEN CAST(@end_date AS datetime)
//               ELSE [occurred_next]
//             END AS [occurred_end]
//             FROM [with_pairing]
//             WHERE [alarm_type] = 'before' AND [next_type] = 'after'
//         ),
//         [filter_time] AS (
//           SELECT
//             *,
//             DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
//           FROM [paired_alarms]
//           WHERE [occurred_end] > [occurred_start]
//         )

//         SELECT
//           [mc_no],
//           SUM([duration_seconds]) AS [sum_duration],
//           DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
//         FROM [filter_time]
//         GROUP BY [mc_no]
//       `
//     );

//     const runningTime = runningTimeResult[1] > 0 ? runningTimeResult[0] : [];

//     const dataArray = prepareRealtimeData(machineData, runningTime);

//     const summary = dataArray.reduce(
//       (acc, item) => {
//         acc.total_target += item.target || 0;
//         acc.total_ok += item.prod_ok || 0;
//         acc.total_cycle_t += item.cycle_t || 0;
//         acc.total_opn += item.opn || 0;
//         acc.count += 1;
//         return acc;
//       },
//       { total_target: 0, total_ok: 0, total_cycle_t: 0, total_opn: 0, count: 0 }
//     );

//     const resultSummary = {
//       sum_target: summary.total_target,
//       sum_daily_ok: summary.total_ok,
//       avg_cycle_t: summary.count > 0 ? Number((summary.total_cycle_t / summary.count).toFixed(2)) : 0,
//       avg_opn: summary.count > 0 ? Number((summary.total_opn / summary.count).toFixed(2)) : 0,
//     };

//     res.json({
//       success: true,
//       data: dataArray,
//       resultSummary,
//     });
//   } catch (error) {
//     console.error("API Error in /machines: ", error);
//     return res.status(500).json({ success: false, message: "Internal Server Error" });
//   }
// });

router.get("/machines", async (req, res) => {
  try {
    const runningTime = await queryCurrentRunningTime();
    const dataArray = prepareRealtimeData(machineData, runningTime);
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
    res.json({ success: true, data: dataArray, resultSummary });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

reloadMasterData();
setInterval(reloadMasterData, 300000);

// module.exports = router;

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime,
  getMachineData: () => machineData,
};
