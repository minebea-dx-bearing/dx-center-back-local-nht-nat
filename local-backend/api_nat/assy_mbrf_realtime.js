const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const mqtt = require("mqtt");
const moment = require("moment");

const master_mc_no = require("../util/mqtt_master_mc_no");
const determineMachineStatus = require("../util/determineMachineStatus");

// In-Memory Cache สำหรับเก็บข้อมูลทั้งหมด
let machineData = {};

// --- Configurations ---
const process = "MBR_F";
const MQTT_SERVER = "10.128.16.111";
const PORT = "1883";
const startTime = 6; // start time 06:00
const DATABASE_PROD = `[nat_mc_assy_${process.toLowerCase()}].[dbo].[DATA_PRODUCTION_${process.toUpperCase()}]`;
const DATABASE_ALARM = `[nat_mc_assy_${process.toLowerCase()}].[dbo].[DATA_ALARMLIS_${process.toUpperCase()}]`;
const DATABASE_MASTER = `[nat_mc_assy_${process.toLowerCase()}].[dbo].[DATA_MASTER_${process.toUpperCase()}]`;

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

const queryCurrentRunningTime = async () => {
  const result = await dbms.query(
    `
        DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${String(startTime).padStart(2, "0")}:00:00';
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
            WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND [alarm] LIKE '%RUN' OR [alarm] LIKE '%RUN_' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%'
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
            CASE
            WHEN [alarm_base] LIKE '%RUN' THEN SUM([duration_seconds]) 
            ELSE  0 
          END AS [sum_duration],
          CASE
            WHEN [alarm_base] = 'PLAN STOP' OR [alarm_base] = 'SETUP' THEN SUM([duration_seconds]) 
            ELSE  0 
          END AS [sum_planshutdown_duration],
            DATEDIFF(SECOND, @start_date, @end_date) AS [total_time]
        FROM [filter_time]
        GROUP BY [mc_no], [alarm_base]
    `
  );
  return result[1] > 0 ? result[0] : [];
};

const prepareRealtimeData = (currentMachineData, runningTimeData) => {
  return Object.values(currentMachineData).map((item) => {
    let f_status_alarm = determineMachineStatus(item, item.alarm, item.occurred);
    
    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    let target =
      item.target_special > 0
        ? item.target_special
        : Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    let f_target_ct = item.target_ct || 0;
    let f_target_utl = item.target_utl || 0;

    // เปลี่ยนชื่อใหม่เหมือนๆกัน
    const f_act_pd = item.match || 0;
    const f_ng_pd = item.a_ng + item.a_ng_pos + item.a_ng_neg + item.a_unm + item.b_ng_pos + item.b_ng_neg + item.b_unm || 0;
    const f_act_ct = item.cycle_time / 100 || 0;

    const now = moment(item.updated_at);
    const start_time = moment().startOf("day").hour(startTime);
    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * now.diff(start_time, "minutes"));

    const f_diff_pd = f_act_pd - f_target_pd;
    const f_diff_ct = Number((f_act_ct - f_target_ct).toFixed(2));

    const f_curr_yield = Number(((f_act_pd / (f_act_pd + f_ng_pd)) * 100 || 0).toFixed(2));

    const f_curr_utl = Number(((( f_act_pd + f_ng_pd ) / (now.diff(start_time, "second") * item.ring_factor / f_target_ct)) * 100).toFixed(2)) || 0;

    const plan_shutdown = runInfo.sum_planshutdown_duration || 0;
    const f_downtime_seconds = total_time - sum_run - plan_shutdown;

    const availability = Number(((sum_run / (total_time - plan_shutdown)) * 100).toFixed(2)) || 0;
    const performance = Number((((f_act_pd + f_ng_pd) / ((total_time - plan_shutdown) / f_target_ct)) * 100).toFixed(2)) || 0;
    const f_oee = Number(((performance / 100) * (availability / 100) * (f_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      // ...item,
      part_no: item.part_no,
      mc_no: item.mc_no.replace("_f", "").toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      f_target_yield: item.target_yield || 0,
      target,
      f_target_pd,
      f_diff_pd,
      f_act_pd,
      f_act_ct,
      f_target_ct,
      f_diff_ct,
      // f_curr_yield,
      // f_curr_utl,
      // f_target_utl,
      // f_status_alarm,
      // f_ng_pd,
      // sum_run,
      // total_time,
      // opn,
      // plan_shutdown,
      // availability,
      // performance,
      f_downtime_seconds,
      f_oee,
    };
  });
};

router.get("/machines", async (req, res) => {
  try {
    const runningTime = await queryCurrentRunningTime();
    const dataArray = prepareRealtimeData(machineData, runningTime);
    // console.log(dataArray)
    res.json({ success: true, data: dataArray });
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
