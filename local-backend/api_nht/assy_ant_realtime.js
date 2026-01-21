const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nht");
const mqtt = require("mqtt");
const moment = require("moment");

const master_mc_no_front_rear = require("../util/mqtt_master_mc_no_front_rear");
const determineMachineStatus = require("../util/determineMachineStatus");

// In-Memory Cache สำหรับเก็บข้อมูลทั้งหมด
let machineData = {};

// --- Configurations ---
const process = "AN";
const MQTT_SERVER = "10.128.16.120";
const PORT = "1883";
const startTime = 6; // start time 06:00
const DATABASE_PROD = `[data_machine_an2].[dbo].[DATA_PRODUCTION_${process.toUpperCase()}]`;
const DATABASE_ALARM = `[data_machine_an2].[dbo].[DATA_ALARMLIS_${process.toUpperCase()}]`;
const DATABASE_MASTER = `[data_machine_an2].[dbo].[DATA_MASTER_${process.toUpperCase()}]`;

const reloadMasterData = async () => {
  console.log(`[${moment().format("HH:mm:ss")}] Reloading master ${process.toUpperCase()} data from SQL...`);
  try {
    const sqlDataArray = await master_mc_no_front_rear(dbms, DATABASE_PROD, DATABASE_ALARM, DATABASE_MASTER);
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
        DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} ${String(startTime).padStart(2, '0')}:00:00';
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
            WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND ([alarm] LIKE 'RUN%' OR [alarm] LIKE 'RUN%' OR [alarm] LIKE 'PLAN STOP%' OR [alarm] LIKE 'SETUP%')
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
            [alarm_base],
            SUM([duration_seconds]) AS [sum_duration],
          CASE
            WHEN [alarm_base] LIKE 'RUN REAR%' OR [alarm_base] LIKE 'RUN FRONT%' THEN SUM([duration_seconds]) 
            ELSE  0 
            END AS [sum_duration],
            CASE
            WHEN [alarm_base] LIKE 'PLAN STOP%' OR [alarm_base] LIKE 'SETUP%' THEN SUM([duration_seconds]) 
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
  // f_ -> Rear, s_ -> Front
  return Object.values(currentMachineData).map((item) => {
    const s_status_alarm = determineMachineStatus(item, item.alarm_front, item.occurred_front);
    const f_status_alarm = determineMachineStatus(item, item.alarm_rear, item.occurred_rear);

    const runInfo = runningTimeData.find((rt) => rt.mc_no === item.mc_no) || {};
    const sum_run = runInfo.sum_duration || 0;
    const total_time = runInfo.total_time || 0;
    const opn = total_time > 0 ? Number(((sum_run / total_time) * 100).toFixed(2)) : 0;

    const runInfoFront = runningTimeData.find((rt) => rt.mc_no === item.mc_no && rt.alarm_base === "RUN FRONT") || {};
    const sum_run_front = runInfoFront.sum_duration || 0;
    const total_time_front = runInfoFront.total_time || 0;
    const opn_front = total_time_front > 0 ? Number(((sum_run_front / total_time_front) * 100).toFixed(2)) : 0;

    const runInfoRear = runningTimeData.find((rt) => rt.mc_no === item.mc_no && rt.alarm_base === "RUN REAR") || {};
    const sum_run_rear = runInfoRear.sum_duration || 0;
    const total_time_rear = runInfoRear.total_time || 0;
    const opn_rear = total_time_rear > 0 ? Number(((sum_run_rear / total_time_rear) * 100).toFixed(2)) : 0;

    let target =
      item.target_special > 0
        ? item.target_special
        : Math.floor((86400 / item.target_ct) * (item.target_utl / 100) * (item.target_yield / 100) * item.ring_factor) || 0;
    let s_target_ct = item.target_ct || 0;
    let s_target_yield = item.target_yield || 0;
    let s_target_utl = item.target_utl || 0;

    // เปลี่ยนชื่อใหม่เหมือนๆกัน
    const prod_ok = item.ok1 + item.ok2 || 0;
    const prod_ng = item.ag + item.ng + item.mix || 0;
    const cycle_t = (item.cycle) / 100 || 0;

    const f_act_pd = item.ok_rear
    const s_act_pd = item.ok_front
    
    const s_act_ct = item.cycle_time_front / 100 || 0;
    const f_act_ct = item.cycle_time_rear / 100 || 0;

    const now = moment(item.updated_at);
    const start_time = moment().startOf("day").hour(startTime);
    const f_target_pd = target === 0 ? 0 : Math.floor((target / (24 * 60)) * now.diff(start_time, "minutes"));

    const diff_prod = prod_ok - f_target_pd;
    const diff_ct = Number((cycle_t - s_target_ct).toFixed(2));

    const yield_rate = Number(((prod_ok / (prod_ok + prod_ng)) * 100 || 0).toFixed(2));

    const s_diff_pd = item.ok_front - f_target_pd;
    const f_diff_pd = item.ok_rear - f_target_pd;

    const s_diff_ct = Number((s_act_ct - s_target_ct).toFixed(2));
    const f_diff_ct = Number((f_act_ct - s_target_ct).toFixed(2));

    const s_ng_pd = item.ag_front + item.ng_front + item.mixball_front;
    const f_ng_pd = item.ag_rear + item.ng_rear + item.mixball_rear;

    const s_curr_yield = Number(((item.ok_front / (item.ok_front + item.ag_front + item.ng_front + item.mixball_front)) * 100 || 0).toFixed(2));
    const f_curr_yield = Number(((item.ok_rear / (item.ok_rear + item.ag_rear + item.ng_rear + item.mixball_rear)) * 100 || 0).toFixed(2));

    const s_curr_utl = Number(((( s_act_pd + s_ng_pd ) / (now.diff(start_time, "second") * item.ring_factor / s_target_ct)) * 100).toFixed(2)) || 0;
    const f_curr_utl = Number(((( f_act_pd + f_ng_pd ) / (now.diff(start_time, "second") * item.ring_factor / s_target_ct)) * 100).toFixed(2)) || 0;
    
    const plan_shutdown_front = runInfoFront.sum_planshutdown_duration || 0;
    const downtime_seconds_front = total_time_front - sum_run_front - plan_shutdown_front;

    const availability_front = Number(((sum_run_front / (total_time_front - plan_shutdown_front)) * 100).toFixed(2)) || 0;
    const performance_front = Number((((item.ok_front + item.ag_front) / ((total_time_front - plan_shutdown_front) / s_target_ct)) * 100).toFixed(2)) || 0;
    const oee_front = Number(((performance_front / 100) * (availability_front / 100) * (s_curr_yield / 100) * 100).toFixed(2)) || 0;

    const plan_shutdown_rear = runInfoRear.sum_planshutdown_duration || 0;
    const downtime_seconds_rear = total_time_rear - sum_run_rear - plan_shutdown_rear;

    const availability_rear = Number(((sum_run_rear / (total_time_rear - plan_shutdown_rear)) * 100).toFixed(2)) || 0;
    const performance_rear = Number((((item.ok_rear + item.ag_rear) / ((total_time_rear - plan_shutdown_rear) / s_target_ct)) * 100).toFixed(2)) || 0;
    const oee_rear = Number(((performance_rear / 100) * (availability_rear / 100) * (f_curr_yield / 100) * 100).toFixed(2)) || 0;

    return {
      // ...item,
      part_no: item.part_no,
      mc_no: item.mc_no.toUpperCase(),
      model: item.model || "NO DATA",
      process: item.process.toUpperCase(),
      target,
      cycle_t,
      prod_ok,
      // rear
      f_target_pd,
      f_act_pd,
      f_diff_pd,
      f_act_ct,
      f_diff_ct,
      f_curr_yield,
      f_target_yield: s_target_yield,
      f_curr_utl,
      f_target_utl: s_target_utl,
      f_status_alarm,
      // front
      s_target_pd: f_target_pd,
      s_act_pd,
      s_diff_pd,
      s_target_ct,
      s_act_ct,
      s_diff_ct,
      s_curr_yield,
      s_target_yield,
      s_curr_utl,
      s_target_utl,
      s_status_alarm,
      // diff_prod,
      // prod_ng,
      // yield_rate,
      // diff_ct,
      // sum_run,
      // total_time,
      // opn,
      // s_ng_pd,
      // f_ng_pd,
      // sum_run_front,
      // total_time_front,
      // opn_front,
      // sum_run_rear,
      // total_time_rear,
      // opn_rear,
      // downtime_seconds_front,
      // plan_shutdown_front,
      // availability_front,
      // performance_front,
      // oee_front,
      // downtime_seconds_rear,
      // plan_shutdown_rear,
      // availability_rear,
      // performance_rear,
      // oee_rear,
    };
  });
};

router.get("/machines", async (req, res) => {
  try {
    const runningTime = await queryCurrentRunningTime();
    const dataArray = prepareRealtimeData(machineData, runningTime);
    const summary = dataArray.reduce(
      (acc, item) => {
        acc.total_target += item.f_target_pd || 0;
        acc.total_ok += item.s_act_pd || 0;
        acc.total_cycle_t += item.s_act_ct || 0;
        acc.total_utl += item.s_curr_utl || 0;
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
