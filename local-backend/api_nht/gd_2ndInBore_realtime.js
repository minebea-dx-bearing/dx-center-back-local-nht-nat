const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nht");
const mqtt = require("mqtt");
const moment = require("moment");

const master_mc_no = require("../util/mqtt_master_mc_no");
const determineMachineStatus = require("../util/determineMachineStatus");

// In-Memory Cache สำหรับเก็บข้อมูลทั้งหมด
let machineData = {};

// --- Configurations ---
const process = "GD";
const MQTT_SERVER = "10.128.16.200";
const PORT = "1883";
const startTime = 7; // start time 07:00
const DATABASE_PROD = `[data_machine_gd2].[dbo].[DATA_PRODUCTION_${process.toUpperCase()}]`;
const DATABASE_ALARM = `[data_machine_gd2].[dbo].[DATA_ALARMLIS_${process.toUpperCase()}]`;
const DATABASE_MASTER = `[data_machine_gd2].[dbo].[DATA_MASTER_${process.toUpperCase()}]`;

const reloadMasterData = async () => {
  console.log(`[${moment().format("HH:mm:ss")}] Reloading master ${process.toUpperCase()} data from SQL...`);
  try {
    const sqlDataArray = await master_mc_no(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER);
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
        console.log(`Machine ${process.toUpperCase()} removed from SQL: ${mc_no}. Deleting from cache.`);
        delete machineData[mc_no];
      }
    }

    console.log(`Master data reloaded. Total machines ${process.toUpperCase()} in cache: ${Object.keys(machineData).length}`);
  } catch (error) {
    console.error("Failed to reload master ${process.toUpperCase()} data:", error);
  }
};

// MQTT connect
const client = mqtt.connect(`mqtt://${MQTT_SERVER}:${PORT}`);
client.on("connect", () => {
  console.log("MQTT Connected");
  client.subscribe("#", (err) => {
    if (!err) console.log(`Subscribed to all topics (#) for ${process.toUpperCase()}`);
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

// const queryCurrentRunningTime = async () => {
//   const result = await dbms.query(
//     `
//         DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${String(startTime).padStart(2, "0")}:00:00';
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
//             WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND [alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%'
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
//                 WHEN [occurred] < @start_date THEN CAST(@start_date AS datetime)
//                 ELSE [occurred]
//             END AS [occurred_start],
//             CASE
//                 WHEN [occurred_next] > @end_date THEN CAST(@end_date AS datetime)
//                 ELSE [occurred_next]
//             END AS [occurred_end]
//             FROM [with_pairing]
//             WHERE [alarm_type] = 'before' AND [next_type] = 'after'
//         ),
//         [filter_time] AS (
//             SELECT
//             *,
//             DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
//             FROM [paired_alarms]
//             WHERE [occurred_end] > [occurred_start]
//         )

//         SELECT
//             [mc_no],
//             CASE
//             WHEN [alarm_base] LIKE '%RUN' THEN SUM([duration_seconds]) 
//             ELSE  0 
//           END AS [sum_duration],
//           CASE
//             WHEN [alarm_base] = 'PLAN STOP' OR [alarm_base] = 'SETUP' THEN SUM([duration_seconds]) 
//             ELSE  0 
//           END AS [sum_planshutdown_duration],
//             DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
//         FROM [filter_time]
//         GROUP BY [mc_no], [alarm_base]
//     `
//   );
//   return result[1] > 0 ? result[0] : [];
// };


async function queryCurrentRunningTime() {
    try {
        
        // 1. ดึงรายชื่อเครื่องจักรทั้งหมดออกมาก่อน
        console.log("Fetching Machine List...");
        let mcResult = await dbms.query(`SELECT DISTINCT [mc_no] FROM [data_machine_gd2].[dbo].[DATA_PRODUCTION_GD] WHERE [mc_no] LIKE 'ir%b' AND [mc_no] IS NOT NULL`);
        const machineList = mcResult[0].map(row => row.mc_no);
        
        let allResults = [];

        // 2. วนลูปประมวลผลทีละเครื่อง
        for (let mc of machineList) {
            console.log(`Processing Machine: ${mc} ...`);
            
            try {
                // ใช้ Template Literal ใส่ mc_no เข้าไปใน WHERE clause
                const query = `
                    DECLARE @mc_no_target VARCHAR(50) = '${mc}';
                    DECLARE @start_date DATETIME = '2026-01-21 07:00:00';
                    DECLARE @end_date DATETIME = GETDATE();
                    DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);
                    DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);

                    WITH [base_alarm] AS (
                        SELECT
                            [mc_no],
                            [occurred], -- ลบ CONVERT VARCHAR ออกเพื่อความเร็ว
                            [alarm],
                            CASE
                                WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1)
                                ELSE [alarm]
                            END AS [alarm_base],
                            CASE
                                WHEN RIGHT([alarm], 1) = '_' THEN 'after'
                                ELSE 'before'
                            END AS [alarm_type]
                        FROM [data_machine_gd2].[dbo].[DATA_ALARMLIS_GD] WITH (NOLOCK)
                        WHERE [mc_no] = @mc_no_target
                          AND [occurred] BETWEEN @start_date_p1 AND @end_date_p1 
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
                            [mc_no], [alarm_base],
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
                        DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
                    FROM [filter_time]
                    GROUP BY [mc_no], [alarm_base]
                `;

                let result = await dbms.query(query);
                
                // เก็บข้อมูลที่ได้ลง Array
                if (result.recordset.length > 0) {
                    allResults.push(...result.recordset);
                }

            } catch (err) {
                console.error(`Error processing ${mc}:`, err.message);
                // ข้ามเครื่องที่ Error ไปทำเครื่องถัดไป
                continue; 
            }
        }

        // 3. รวมผลลัพธ์และจัดการต่อ (เช่น ส่งไป Frontend หรือบันทึกลงไฟล์)
        console.log("Batch Process Completed!");
        console.table(allResults); // โชว์ผลลัพธ์ในรูปแบบตารางบน Console
        return allResults[1] > 0 ? allResults[0] : [];

    } catch (err) {
        console.error("Connection Error:", err);
    } finally {
        sql.close();
    }
}

const prepareRealtimeData = (currentMachineData, runningTimeData) => {
  return Object.values(currentMachineData).map((item) => {
    let status_alarm = determineMachineStatus(item, item.alarm, item.occurred);

    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    let target =
      item.target_special > 0
        ? item.target_special
        : Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    let target_ct = item.target_ct || 0;
    let target_utl = item.target_utl || 0;

    // เปลี่ยนชื่อใหม่เหมือนๆกัน
    const act_pd = item.prod_total || 0;
    const ng_pd = item.ng_p + item.ng_n || 0;
    const act_ct = item.eachct / 100 || 0;

    const now = moment(item.updated_at);
    const start_time = moment().startOf("day").hour(startTime);
    const target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * now.diff(start_time, "minutes"));

    const diff_pd = act_pd - target_pd;
    const diff_ct = Number((act_ct - target_ct).toFixed(2));

    const curr_yield = Number(((act_pd / (act_pd + ng_pd)) * 100 || 0).toFixed(2));

    const curr_utl = Number(((( act_pd + ng_pd ) / (now.diff(start_time, "second") * item.ring_factor / target_ct)) * 100).toFixed(2)) || 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const performance = Number((((act_pd + ng_pd) / ((total_time - plan_shutdown) / target_ct)) * 100).toFixed(2)) || 0;
    const oee = Number(((performance / 100) * (availability / 100) * (curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      subProcess: item.process.toUpperCase()+"-IB",
      status_alarm,
      target,
      target_pd,
      act_pd,
      diff_pd,
      act_ct,
      diff_ct,
      curr_yield,
      target_ct,
      target_utl,
      curr_utl,
      sum_run,
      total_time,
      opn,
      downtime_seconds,
      plan_shutdown,
      availability,
      performance,
      oee,
    };
  });
};

router.get("/machines", async (req, res) => {
  try {
    const runningTime = await queryCurrentRunningTime();
    const dataArray = prepareRealtimeData(machineData, runningTime).filter((item) => item.mc_no.startsWith("IR") && item.mc_no.endsWith("B"));
    const summary = dataArray.reduce(
      (acc, item) => {
        acc.total_target += item.target_pd || 0;
        acc.total_ok += item.act_pd || 0;
        acc.total_cycle_t += item.act_ct || 0;
        acc.total_utl += item.curr_utl || 0;
        acc.count += 1;
        return acc;
      },
      { total_target: 0, total_ok: 0, total_cycle_t: 0, total_utl: 0, count: 0 }
    );

    const resultSummary = {
      sum_target: summary.total_target,
      sum_daily_ok: summary.total_ok,
      avg_cycle_t: summary.count > 0 ? Number((summary.total_cycle_t / summary.count).toFixed(2)) : 0,
      avg_utl: summary.count > 0 ? Number((summary.total_utl / summary.count).toFixed(2)) : 0,
    };
    res.json({ success: true, data: dataArray, resultSummary });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

reloadMasterData();
setInterval(reloadMasterData, 300000);

module.exports = {
  router,
  prepareRealtimeData,
  queryCurrentRunningTime,
  getMachineData: () => machineData,
};
