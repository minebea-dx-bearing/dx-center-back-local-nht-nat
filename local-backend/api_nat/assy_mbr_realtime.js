const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const mqtt = require("mqtt");
const moment = require("moment");

let machineData = {}; // ตัวเก็บค่ากลาง

const MQTT_SERVER = "10.128.16.111";
const DATABASE_PROD = "[nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR]";
const DATABASE_ALARM = "[nat_mc_assy_mbr].[dbo].[DATA_ALARMLIS_MBR]";

// ฟังก์ชัน query ค่าเริ่มต้นจาก SQL
const master_mc_no = async () => {
  try {
    const mc_no = await dbms.query(`
      WITH LatestProduction AS (
        SELECT
            [registered]
            ,[mc_no]
            ,[process]
            ,[rssi]
            ,[daily_ok]
            ,[daily_ng]
            ,[daily_tt]
            ,[c1_ok]
            ,[c2_ok]
            ,[c3_ok]
            ,[c4_ok]
            ,[c5_ok]
            ,[c1_ng]
            ,[c2_ng]
            ,[c3_ng]
            ,[c4_ng]
            ,[c5_ng]
            ,[ball_q]
            ,[ball_ang]
            ,[sep_ng_1]
            ,[sep_ng_2]
            ,[rtnr_ng]
            ,[d1_ng]
            ,[d2_ng]
            ,[pre_p_ng]
            ,[m_p_ng]
            ,[press_check_ng]
            ,[rtnr_camera_ng]
            ,[cycle_t]
            ,[model]
            ,[spec]
            ,[time_hr]
            ,[time_min]
            ,ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
        FROM ${DATABASE_PROD}
      ),
      LatestAlarm AS (
        SELECT
            [mc_no],[alarm],[occurred],
            ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [occurred] DESC) AS rn
        FROM ${DATABASE_ALARM}
        WHERE [alarm] LIKE 'RUN%'
      )
      SELECT 
          p.[registered]
          ,p.[mc_no]
          ,p.[process]
          ,p.[rssi]
          ,p.[daily_ok]
          ,p.[daily_ng]
          ,p.[daily_tt]
          ,p.[c1_ok]
          ,p.[c2_ok]
          ,p.[c3_ok]
          ,p.[c4_ok]
          ,p.[c5_ok]
          ,p.[c1_ng]
          ,p.[c2_ng]
          ,p.[c3_ng]
          ,p.[c4_ng]
          ,p.[c5_ng]
          ,p.[ball_q]
          ,p.[ball_ang]
          ,p.[sep_ng_1]
          ,p.[sep_ng_2]
          ,p.[rtnr_ng]
          ,p.[d1_ng]
          ,p.[d2_ng]
          ,p.[pre_p_ng]
          ,p.[m_p_ng]
          ,p.[press_check_ng]
          ,p.[rtnr_camera_ng]
          ,p.[cycle_t] / 100.0 AS [cycle_t]
          ,p.[model]
          ,p.[spec]
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
    `);

    return mc_no[0];
  } catch (error) {
    console.error("Database Query Error: ", error);
    return [];
  }
};

// โหลดค่าตั้งต้นจาก SQL มาครั้งแรก
(async () => {
  const initialData = await master_mc_no();
  machineData = {};
  initialData.forEach((row) => {
    machineData[row.mc_no] = { ...row, source: "SQL" };
  });
  console.log("Initial machine data loaded:", Object.keys(machineData).length, "machines");
})();

// MQTT connect
const PORT = "1883";
const client = mqtt.connect(`mqtt://${MQTT_SERVER}:${PORT}`);

client.on("connect", () => {
  console.log("MQTT Connected");
  client.subscribe("#", (err) => {
    if (!err) console.log("Subscribed to all topics (#)");
  });
});

// เวลา message เข้า → update ข้อมูลใน memory
client.on("message", (topic, message) => {
  try {
    const mc_no = topic.split("/").pop();

    if (machineData.hasOwnProperty(mc_no)) {
      const mqttData = JSON.parse(message.toString());

      if (mqttData.hasOwnProperty("mc_no")) {
        mqttData.mc_no = mqttData.mc_no.toUpperCase();
      }

      if (mqttData.hasOwnProperty("cycle_t")) {
        mqttData.cycle_t = mqttData.cycle_t / 100;
      }

      if (machineData.hasOwnProperty(mc_no)) {
        machineData[mc_no] = {
          ...machineData[mc_no],
          ...mqttData,
          updated_at: moment().format("YYYY-MM-DD HH:mm:ss"),
          source: "MQTT",
        };
      } else {
        console.log(`New machine detected: ${mc_no}. Adding to cache.`);
        machineData[mc_no] = {
          ...mqttData,
          registered: moment().format("YYYY-MM-DD HH:mm:ss"),
          alarm: 'no data',
          updated_at: moment().format("YYYY-MM-DD HH:mm:ss"),
          source: "MQTT",
        };
      }
    }
  } catch (error) {
    console.error("MQTT Message Error: ", error);
  }
});

// API ให้ frontend มาเรียก
router.get("/machines", async (req, res) => {
  try {
    let runningTime = await dbms.query(
      `
        DECLARE @start_date DATETIME = '${moment().format("YYYY-MM-DD")} 07:00:00';
        DECLARE @end_date DATETIME = GETDATE();
        DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);    -- เวลาที่ต้องการลบไป 2hr เพื่อดึง alarm ตัวก่อนหน้า --
        DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);        -- เวลาที่ต้องการบวกไป 2hr เพื่อดึง alarm ตัวหลัง --

        WITH [base_alarm] AS (
            -- เรียก data ทั้งหมด ก่อนและหลัง 1hr --
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
            WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND [alarm] IN ('RUN', 'RUN_')
        ),
        [with_pairing] AS (
            -- จับคู่ alarm กับ alarm_ --
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
            -- filter เฉพาะตัวที่มี alarm , alarm_ และ check ตัว alarm ที่เกิดซ้อนอยู่ใน alarm อีกตัว --
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
      } else if (item.alarm.includes("RUN") && item.alarm.slice(-1) !== "_") {
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

      if (item.model.includes("R-830")) {
        target = Number((47500 * (runInfo?.total_time || 0) / 86400).toFixed(0));
        target_ct = 1.6;
      }

      // เปลี่ยนชื่อใหม่เหมือนๆกัน
      const prod_ok = item.daily_ok || 0;
      const prod_ng = item.daily_ng || 0;
      const cycle_t = item.cycle_t || 0;
      

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
        target_ct
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
      resultSummary
    });
  } catch (error) {
    console.error("API Error: ", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
