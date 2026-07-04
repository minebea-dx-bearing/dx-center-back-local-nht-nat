const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment-timezone");

const DATABASE_PROD = "[nat_mc_assy_ant_new].[dbo].[DATA_PRODUCTION_ANT]";
const DATABASE_ALARM = "[nat_mc_assy_ant_new].[dbo].[DATA_ALARMLIS_ANT]";
const DATABASE_IOT = "[nat_mc_assy_ant_new].[dbo].[MONITOR_IOT]";
const DATABASE_MASTER = "[nat_mc_assy_ant_new].[dbo].[DATA_MASTER_ANT]";

const COLUMN_OK_REAR = "[ok_rear]";
const COLUMN_NG_REAR = "[ag_rear] + [ng_rear] + [mixball_rear]";
const COLUMN_TOTAL_REAR = `(${COLUMN_OK_REAR} + ${COLUMN_NG_REAR})`;
const COLUMN_CT_REAR = "[cycle_time_rear]";

const COLUMN_OK_FRONT = "[ok_front]";
const COLUMN_NG_FRONT = "[ag_front]+[ng_front]+[mixball_front]";
const COLUMN_TOTAL_FRONT = `(${COLUMN_OK_FRONT} + ${COLUMN_NG_FRONT})`;
const COLUMN_CT_FRONT = "[cycle_time_front]";

const calcTargetProd = (timeSeconds, row) => {
  if (row.target_special && row.target_special !== "") {
    return Number((row.target_special / 86400) * timeSeconds);
  }
  return (timeSeconds / row.target_ct) * (row.target_utl / 100) * (row.target_yield / 100) * row.ring_factor;
};

const calculateShifts = (data, date) => {
  let M = null;
  let N = null;
  let All = null;

  const now = new Date();
  const todayStr = moment().format("YYYY-MM-DD");

  // -------------------------------------------------
  // ถ้าวันที่ = วันนี้  → คำนวณ All แบบ real-time
  // -------------------------------------------------
  if (date === todayStr) {
    const A_start = data.find((r) => r.TIME.startsWith("07:"));
    const nowHour = now.getHours();
    const nowStr = `${nowHour.toString().padStart(2, "0")}:`;
    const A_end = data.find((r) => r.TIME.startsWith(nowStr)) || data[data.length - 1];

    if (A_start && A_end) {
      const diff_total = A_end.prod_total;
      const diff_ok = A_end.prod_ok;
      const seconds = (nowHour - 6) * 3600;

      const target_prod = calcTargetProd(seconds, A_start);
      const utl = (diff_total / (seconds / A_end.target_ct)) * 100 * A_end.ring_factor || 0.00;
      const ach = (diff_total / target_prod) * 100 || 0.00;
      const yieldVal = (diff_ok / diff_total) * 100 || 0.00;

      All = {
        ...A_end,
        prod_total: diff_total,
        prod_ok: diff_ok,
        target_prod: Math.round(target_prod),
        utl: utl.toFixed(2),
        ach: ach.toFixed(2),
        yield: yieldVal.toFixed(2),
      };
      M = { ...All };
    }
  }
  // -------------------------------------------------
  // ถ้าเป็นวันก่อนหน้า  → คำนวณ M, N และรวม All
  // -------------------------------------------------
  else {
    // ----------------- M -----------------
    const Mrow = data.find((r) => r.TIME.startsWith("18:"));
    if (Mrow) {
      const seconds = 12 * 3600;
      const target_prod = calcTargetProd(seconds, Mrow);
      const utl = (Mrow.prod_total / (seconds / Mrow.target_ct)) * 100 * Mrow.ring_factor || 0.00;
      const ach = (Mrow.prod_total / target_prod) * 100 || 0.00;
      const yieldVal = (Mrow.prod_ok / Mrow.prod_total) * 100 || 0.00;

      M = {
        ...Mrow,
        target_prod: Math.round(target_prod),
        utl: utl.toFixed(2),
        ach: ach.toFixed(2),
        yield: yieldVal.toFixed(2),
      };
    }

    // ----------------- N -----------------
    const N_start = data.find((r) => r.TIME.startsWith("18:"));
    const N_end = data.find((r) => r.TIME.startsWith("06:"));
    if (N_start && N_end) {
      const diff_total = N_end.prod_total - N_start.prod_total;
      const diff_ok = N_end.prod_ok - N_start.prod_ok;
      const diff_ng = N_end.prod_ng - N_start.prod_ng;
      const seconds = 12 * 3600;
      const target_prod = calcTargetProd(seconds, N_start);
      const utl = (diff_total / (seconds / N_start.target_ct)) * 100 * N_start.ring_factor || 0.00;
      const ach = (diff_total / target_prod) * 100 || 0.00;
      const yieldVal = (diff_ok / diff_total) * 100 || 0.00;

      N = {
        ...N_end,
        prod_total: diff_total,
        prod_ok: diff_ok,
        prod_ng: diff_ng,
        target_prod: Math.round(target_prod),
        utl: utl.toFixed(2),
        ach: ach.toFixed(2),
        yield: yieldVal.toFixed(2),
      };
    }

    // ----------------- ALL -----------------
    if (M && N) {
      const diff_total = M.prod_total + N.prod_total;
      const diff_ok = M.prod_ok + N.prod_ok;
      const diff_ng = M.prod_ng + N.prod_ng;

      const seconds = 24 * 3600; // 24 ชั่วโมงเต็ม
      const target_prod = calcTargetProd(seconds, M || N);
      const utl = (diff_total / (seconds / M.target_ct)) * 100 * M.ring_factor || 0.00;

      const ach = (diff_total / target_prod) * 100 || 0.00;
      const yieldVal = (diff_ok / diff_total) * 100 || 0.00;

      All = {
        ...data[data.length - 1],
        model: M?.model || N?.model,
        mc_no: M?.mc_no || N?.mc_no,
        part_no: M?.part_no || N?.part_no,
        mfg_date: M?.mfg_date || N?.mfg_date,
        prod_total: diff_total,
        prod_ok: diff_ok,
        prod_ng: diff_ng,
        target_prod: Math.round(target_prod),
        utl: utl.toFixed(2),
        ach: ach.toFixed(2),
        yield: yieldVal.toFixed(2),
      };
    } else {
      All = { ...M };
    }
  }

  // -----------------
  // ส่งผลลัพธ์กลับ
  // -----------------
  //   return { M, N, All };
  return {
    M: M ? [M] : [],
    N: N ? [N] : [],
    All: All ? [All] : [],
  };
}

// MASTER MACHINE NO.
router.get("/master_machine", async (req, res) => {
  try {
    let master = await dbms.query(
      `
        SELECT DISTINCT(UPPER(LEFT([mc_no], 3) + RIGHT('0' + CONVERT(VARCHAR(10), CONVERT(INT, RIGHT([mc_no], 2)) + (CONVERT(INT, RIGHT([mc_no], 2)) - 1)),2))) AS mc_no
        FROM [nat_mc_assy_ant_new].[dbo].[DATA_PRODUCTION_ANT]
        WHERE ${COLUMN_TOTAL_REAR} <> 0
        UNION ALL
        SELECT DISTINCT(UPPER(LEFT([mc_no], 3) + RIGHT('0' + CONVERT(VARCHAR(10), (CONVERT(INT, RIGHT([mc_no], 2)) * 2)),2))) AS mc_no
            FROM [nat_mc_assy_ant_new].[dbo].[DATA_PRODUCTION_ANT]
        WHERE ${COLUMN_TOTAL_FRONT} <> 0
        ORDER BY mc_no ASC
      `
    );

    res.json({ data: master[0], success: true, message: "ok" });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

// PRODUCTION BY HOUR
router.get("/production_hour_by_mc/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    const mc = Number(mc_no.slice(-2))
    const calc = (mc % 2 === 0) ? mc/2 : (mc+1)/2
    const calc_mc_no = mc_no.slice(0,3) + String(calc).padStart(2, '0')
    // console.log(mc_no)

    const query = (mc % 2 === 0) ? `
        ${COLUMN_OK_FRONT} AS daily_ok,
        ${COLUMN_TOTAL_FRONT} AS daily_total,
        ${COLUMN_CT_FRONT} AS [cycle_t],
        CASE 
              WHEN ${COLUMN_TOTAL_FRONT} = 0 THEN 0
              ELSE cast((${COLUMN_OK_FRONT} * 1.0 / ${COLUMN_TOTAL_FRONT}) * 100 AS decimal(20, 2)) -- คูณ 1.0 เพื่อป้องกัน Integer Division (หารแล้วทศนิยมหาย)
        END AS yield,
    ` : `
        ${COLUMN_OK_REAR} AS daily_ok,
        ${COLUMN_TOTAL_REAR} AS daily_total,
        ${COLUMN_CT_REAR} AS [cycle_t],
        CASE 
              WHEN ${COLUMN_TOTAL_REAR} = 0 THEN 0
              ELSE cast((${COLUMN_OK_REAR} * 1.0 / ${COLUMN_TOTAL_REAR}) * 100 AS decimal(20, 2)) -- คูณ 1.0 เพื่อป้องกัน Integer Division (หารแล้วทศนิยมหาย)
        END AS yield,
    `

    let data = await dbms.query(`
        SELECT [registered],
            convert(varchar, [registered], 8) AS TIME,
            format(iif(DATEPART(HOUR, [registered]) < 7, dateadd(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') AS [mfg_date],
            '${mc_no}' AS [mc_no],
            ${query}
            FORMAT(registered, 'HH:mm') AS cat_time
        FROM ${DATABASE_PROD}
        WHERE mc_no = '${calc_mc_no}'
        AND FORMAT(IIF(DATEPART(HOUR, [registered]) < 7, DATEADD(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') = '${date}'
        ORDER BY registered ASC
    `);

    if (data[0].length > 0) {
      arrayData = data[0];
      arrayData_yield = data[0];
      let calData = [];
      const index_data = arrayData[0].daily_total;
      await calData.push(index_data);

      for (let i = 0; i < arrayData.length - 1; i++) {
        await calData.push(arrayData[i + 1].daily_total - arrayData[i].daily_total < 0 ? 0 : arrayData[i + 1].daily_total - arrayData[i].daily_total);
      }

      let yieldData = [];
      for (let i = 0; i < arrayData_yield.length; i++) {
        await yieldData.push(Number(arrayData_yield[i].yield.toFixed(2)));
      }
      
      // 1. สร้าง Map หรือ Object เพื่อให้ค้นหาได้เร็ว (ดึงเฉพาะ HH มาเป็น Key)
      const defaultHours = [
        "07:00",
        "08:00",
        "09:00",
        "10:00",
        "11:00",
        "12:00",
        "13:00",
        "14:00",
        "15:00",
        "16:00",
        "17:00",
        "18:00",
        "19:00",
        "20:00",
        "21:00",
        "22:00",
        "23:00",
        "00:00",
        "01:00",
        "02:00",
        "03:00",
        "04:00",
        "05:00",
        "06:00",
      ];
      const dataMap = {};
      data[0].forEach((item) => {
        const hour = item.cat_time.split(":")[0]; // ดึง "07" จาก "07:07"
        dataMap[hour] = item.cat_time;
      });

      // 2. วนลูป defaultHours เพื่อสร้างผลลัพธ์ใหม่
      const finalDate = defaultHours.map((hourStr) => {
        const hourKey = hourStr.split(":")[0]; // ดึง "07" จาก "07:00"

        // ถ้าใน dataMap มี key นี้ (เช่น "07") ให้ใช้ค่าจริง (07:07)
        // ถ้าไม่มีให้ใช้ค่า default (07:00)
        return dataMap[hourKey] ? dataMap[hourKey] : hourStr;
      });

      res.json({
        data: calData,
        yield: yieldData,
        data_raw: data[0],
        data_date: finalDate,
        success: true,
        message: "ok",
      });
    } else {
      res.json({ data: [], data_raw: data[0], success: true, message: "ok" });
    }
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

router.get("/status/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    let dateTomarrow = moment(date).add(1, "day").endOf("day").format("YYYY-MM-DD");

    const mc = Number(mc_no.slice(-2))
    const calc = (mc % 2 === 0) ? mc/2 : (mc+1)/2
    const calc_mc_no = mc_no.slice(0,3) + String(calc).padStart(2, '0')
    const alarm_condition = (mc % 2 === 0) ? `AND alarm LIKE '%FRONT%'` : `AND alarm LIKE '%REAR%'`

    let data = await dbms.query(`
      DECLARE @start_date DATETIME = '${date} 06:00';
      DECLARE @TargetEndDate DATETIME = '${dateTomarrow} 06:00';
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
              CASE WHEN RIGHT([alarm], 1) = '_' THEN 'after' ELSE 'before' END AS [alarm_type]
          FROM ${DATABASE_ALARM}
          WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND alarm NOT LIKE 'YIELD RATE LOW%' ${alarm_condition}
      ),
      [with_pairing] AS (
          -- จับคู่ alarm กับ alarm_ --
          SELECT *,
              ISNULL(LEAD([occurred]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]), @end_date) AS [occurred_next],
              ISNULL(LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]), 'after') AS [next_type]
          FROM [base_alarm]
      ),
      [paired_alarms] AS (
          -- filter เฉพาะตัวที่มี alarm , alarm_ และ check ตัว alarm ที่เกิดซ้อนอยู่ใน alarm อีกตัว --
          SELECT
              [mc_no],
              IIF([status_alarm] LIKE 'run%', 'run', [status_alarm]) AS [status_alarm],
              [occurred] AS [occurred_start],
              [occurred_next] AS [occurred_end]
          FROM [with_pairing]
          WHERE [alarm_type] = 'before' AND [next_type] = 'after'
      ),
      [yield_low] AS (
        SELECT 
          [mc_no],
          [occurred],
          [alarm],
          CASE
            WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1)
            ELSE [alarm]
          END AS [status_alarm],
          CASE WHEN RIGHT([alarm], 1) = '_' THEN 'after' ELSE 'before' END AS [alarm_type]
        FROM ${DATABASE_ALARM}
        WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1 AND alarm LIKE 'YIELD RATE LOW%' AND alarm LIKE '%FRONT%'
      ),
      [with_pairing_yield] AS (
          -- จับคู่ alarm กับ alarm_ --
          SELECT *,
              ISNULL(LEAD([occurred]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]), @end_date) AS [occurred_next],
              ISNULL(LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [status_alarm] ORDER BY [occurred]), 'after') AS [next_type]
          FROM [yield_low]
      ),
      [paired_alarms_yield] AS (
          -- filter เฉพาะตัวที่มี alarm , alarm_ และ check ตัว alarm ที่เกิดซ้อนอยู่ใน alarm อีกตัว --
          SELECT
              [mc_no],
              [status_alarm],
              [occurred] AS [occurred_start],
              [occurred_next] AS [occurred_end]
          FROM [with_pairing_yield]
          WHERE [alarm_type] = 'before' AND [next_type] = 'after'
      ),
      [base_monitor_iot] AS (
          SELECT
              [mc_no],
              [registered],
              CAST(broker AS FLOAT) AS [broker_f]
          FROM ${DATABASE_IOT}
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
              CASE WHEN [max_prev_end] IS NOT NULL AND [occurred_end] <= [max_prev_end] THEN 1 ELSE 0 END AS [duplicate]
          FROM [with_max_prev]
      ),
      [rm_dup] AS (
        SELECT
          [mc_no],
          [status_alarm],
          [occurred_start],
          [occurred_end],
          LAG([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [prev_start],
          LAG([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [prev_end]
        FROM [check_duplicate]
        WHERE [duplicate] = 0
      ),
      [get_yield_alarm] AS (
        -- เอา YIELD RATE LOW ที่เกิดระหว่าง alarm ก่อนหน้าและหลังมา และต้องจบหลังจากเวลา alarm ก่อนหน้าจบ
        SELECT 
          t2.[mc_no],
          t2.[status_alarm],
          t2.[occurred_start],
          t2.[occurred_end],
          t1.[status_alarm] AS [t1_alarm],
          t1.[prev_start] ,
          t1.[occurred_start] AS [t1_start],
          t1.[prev_end],
          t1.[occurred_end] AS [t1_end]
        FROM [paired_alarms_yield] t2
        INNER JOIN [rm_dup] t1 
          ON t2.[mc_no] = t1.[mc_no]
        AND t1.[occurred_start] > t1.[prev_end]
        AND t2.[occurred_start] BETWEEN t1.[prev_start] AND t1.[occurred_start]
        AND t2.[occurred_end] > t1.[prev_end]
      ),
      [merge] AS (
        SELECT 
          [mc_no],
          [status_alarm],
          [occurred_start],
          [occurred_end]
        FROM [rm_dup]
        UNION
        SELECT
          [mc_no],
          [status_alarm],
          [occurred_start],
          [occurred_end]
        FROM [get_yield_alarm]
      ),
      [clamped_alarms] AS (
          -- ตัดตัวที่เป็น alarm ซ้อนใน alarm อีกตัวออกและเพิ่มเวลาก่อนและหลังเพื่อคำนวณ --
          SELECT
              [mc_no],
              [status_alarm],
              [occurred_start],
              [occurred_end],
          LAG([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [previous_end],
              LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [next_start],
              LEAD([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [next_end]
          FROM [merge]
      ),
      [edit_occurred] AS (
          -- filter เอาเฉพาะเวลาที่ต้องการ , ถ้า alarm = mc_run แล้วเวลาซ้อนกับ alarm ตัวอื่นจะตัดเวลา alarm ตัวนั้นออก , ถ้าเป็น alarm1 เหลื่อม alarm2 จะตัดเวลา alarm1 ออกตามที่เหลื่อม --
          SELECT
              *,
              CASE
                  WHEN [occurred_start] < [previous_end] AND [previous_end] < [occurred_end] THEN [previous_end]
                  ELSE [occurred_start]
              END AS [new_occurred_start],
          CASE
                  WHEN [occurred_end] < [next_end] OR [next_end] IS NULL THEN [occurred_end]
                  ELSE [next_start]
              END AS [new_occurred_end]
          FROM [clamped_alarms]
      ),
      [final_raw_alarm] AS (
        SELECT 
          UPPER([mc_no]) AS [mc_no], 
          IIF([status_alarm] LIKE 'YIELD RATE LOW%', 'RUN', UPPER([status_alarm])) AS [status_alarm], 
          [new_occurred_start] AS [occurred_start], 
          [new_occurred_end] AS [occurred_end],
          LEAD([new_occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [new_occurred_start]) AS [next_start],
          ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [new_occurred_start]) AS [rn_start],
          ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [new_occurred_end] desc) AS [rn_end]
        FROM [edit_occurred]
      ),
      [insert_stop] AS (
          -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
          SELECT
              [mc_no],
              'STOP' AS [status_alarm],
              [occurred_end] AS [occurred_start],
              [next_start] AS [occurred_end]
          FROM [final_raw_alarm]
          WHERE [next_start] > [occurred_end]
        UNION ALL
          -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
          SELECT
              [mc_no],
              'STOP' AS [status_alarm],
              [occurred_end] AS [occurred_start],
              @end_date AS [occurred_end]
          FROM [final_raw_alarm]
          WHERE [occurred_end] < @TargetEndDate AND [rn_end] = 1
        UNION ALL
          -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
          SELECT
              [mc_no],
              'STOP' AS [status_alarm],
              @start_date AS [occurred_start],
              [next_start] AS [occurred_end]
          FROM [final_raw_alarm]
          WHERE [occurred_start] > @start_date AND [rn_start] = 1
      ),
      [combine_result] AS (
          -- รวม alarm ทั้งหมดกับ STOP เข้าด้วยกัน --
          SELECT UPPER([mc_no]) AS [mc_no], UPPER([status_alarm]) AS [status_alarm], [occurred_start], [occurred_end] FROM [final_raw_alarm]
          UNION ALL
          SELECT UPPER([mc_no]) AS [mc_no], [status_alarm], [occurred_start], [occurred_end] FROM [insert_stop]
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
          WHERE [occurred_end] > [occurred_start]
      )
      SELECT
        '${mc_no}' AS [mc_no],
        [status_alarm],
        [occurred_start],
        [occurred_end],
        DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
      FROM [filter_result]
      WHERE [mc_no] = '${calc_mc_no}' AND DATEDIFF(SECOND, [occurred_start], [occurred_end]) <> 0
      ORDER BY [mc_no], [occurred_start]
    `);
    const colorMap = {};
    const palette = [
      "#F59127",
      "#ebaed3",
      "#ffe119",
      "#0082c8",
      "#f58231",
      "#911eb4",
      "#46f0f0",
      "#f032e6",
      "#d2f53c",
      "#fabebe",
      "#008080",
      "#e6beff",
      "#aa6e28",
      "#fffac8",
      "#800000",
      "#aaffc3",
      "#808000",
      "#ffd8b1",
      "#000080",
      "#808080",
      "#FFFFFF",
      "#000000",
      "#9A6324",
      "#469990",
      "#dcbeff",
      "#4363d8",
      "#bcf60c",
      "#fabed4",
      "#a9a9a9",
      "#42d4f4",
      "#f032e6",
      "#bfef45",
      "#9c27b0",
      "#ff9800",
      "#795548",
      "#03a9f4",
      "#8bc34a",
      "#ffc107",
      "#607d8b",
      "#673ab7",
      "#ff5722",
      "#4caf50",
      "#009688",
      "#e91e63",
      "#9e9e9e",
      "#2196f3",
      "#cddc39",
      "#00bcd4",
      "#ffeb3b",
      "#f44336",
      "#d500f9",
      "#69f0ae",
      "#ffab40",
      "#18ffff",
      "#ff4081",
      "#76ff03",
      "#40c4ff",
      "#ff6e40",
      "#ea80fc",
      "#64ffda",
      "#ffff00",
      "#ff8a80",
      "#c51162",
      "#6200ea",
      "#2962ff",
      "#00bfa5",
      "#aeea00",
      "#ffd600",
      "#ff9100",
      "#ff3d00",
      "#b388ff",
      "#8c9eff",
      "#80d8ff",
      "#84ffff",
      "#b9f6ca",
      "#ccff90",
      "#f4ff81",
      "#ffe57f",
      "#ffd180",
      "#ff9e80",
      "#ef9a9a",
      "#f48fb1",
      "#ce93d8",
      "#b39ddb",
      "#9fa8da",
      "#90caf9",
      "#81d4fa",
      "#80deea",
      "#80cbc4",
      "#a5d6a7",
      "#c5e1a5",
      "#e6ee9c",
      "#fff59d",
      "#ffe082",
      "#ffcc80",
      "#ffab91",
      "#bcaaa4",
      "#eeeeee",
      "#b0bec5",
      "#eb0cc5",
      "#c2185b",
      "#7b1fa2",
      "#512da8",
      "#303f9f",
      "#1976d2",
      "#0288d1",
      "#0097a7",
      "#00796b",
      "#388e3c",
      "#689f38",
      "#afb42b",
      "#fbc02d",
      "#ffa000",
      "#f57c00",
      "#e64a19",
      "#5d4037",
      "#616161",
      "#455a64",
      "#d848c0",
      "#6e2740",
      "#d500f9",
      "#651fff",
      "#3d5afe",
      "#2979ff",
      "#00b0ff",
      "#00e5ff",
      "#1de9b6",
      "#00e676",
      "#76ff03",
      "#c6ff00",
      "#ffea00",
      "#ffc400",
      "#ff9100",
      "#7b84da",
      "#f44336",
      "#e91e63",
      "#9c27b0",
      "#673ab7",
      "#3f51b5",
      "#2196f3",
      "#03a9f4",
      "#00bcd4",
      "#009688",
      "#4caf50",
      "#8bc34a",
      "#cddc39",
      "#ffeb3b",
      "#ffc107",
      "#ff9800",
      "#ff5722",
      "#795548",
      "#9e9e9e",
      "#607d8b",
      "#263238",
      "#f06292",
      "#ba68c8",
      "#9575cd",
      "#7986cb",
      "#64b5f6",
      "#4fc3f7",
      "#4dd0e1",
      "#4db6ac",
      "#81c784",
      "#aed581",
      "#dce775",
      "#fff176",
      "#ffd54f",
      "#ffb74d",
      "#ff8a65",
      "#a1887f",
      "#e0e0e0",
      "#90a4ae",
      "#a09828",
      "#ad1457",
      "#6a1b9a",
      "#4527a0",
      "#485191",
      "#1565c0",
      "#0277bd",
      "#00838f",
      "#00695c",
      "#2e7d32",
      "#558b2f",
      "#9e9d24",
      "#f9a825",
      "#ff8f00",
      "#ef6c00",
      "#ee9b82",
      "#4e342e",
      "#424242",
      "#37474f",
      "#ff5252",
      "#ff4081",
      "#e040fb",
      "#7c4dff",
      "#536dfe",
      "#448aff",
      "#40c4ff",
      "#18ffff",
      "#64ffda",
      "#69f0ae",
      "#b2ff59",
      "#eeff41",
      "#ffff00",
      "#ffd740",
      "#ffab40",
      "#ff6e40",
      "#1e2020",
      "#df779d",
      "#8e24aa",
      "#5e35b1",
      "#3949ab",
      "#1e88e5",
      "#039be5",
      "#00acc1",
      "#00897b",
      "#43a047",
      "#7cb342",
      "#c0ca33",
      "#fdd835",
    ];

    const getColor = (status) => {
      if (status.includes("RUN")) return "#16C809";
      if (status.includes("STOP")) return "#F40B0B";
      if (!colorMap[status]) {
        colorMap[status] = palette[Object.keys(colorMap).length % palette.length];
      }
      return colorMap[status];
    };
    function generateData(raw) {
      return raw.map((item) => {
        const start = moment(item.occurred_start).utc().format("YYYY-MM-DD HH:mm:ss");
        const end = moment(item.occurred_end).utc().format("YYYY-MM-DD HH:mm:ss");
        const color = getColor(item.status_alarm);

        return {
          ...item,
          color, // ✅ เพิ่ม color ที่ match status_alarm
          name: item.status_alarm,
          value: [0, start, end, item.duration_seconds, item.occurred_start, item.occurred_end],
          itemStyle: { color },
        };
      });
    }

    // ========================================
    // Summary ตาม status_alarm (ใช้ data[0] ที่มี color แล้ว)
    // ========================================
    function summarize(data) {
      return Object.values(
        data.reduce((acc, { status_alarm, duration_seconds, color }) => {
          if (!acc[status_alarm]) {
            acc[status_alarm] = {
              alarm: status_alarm,
              count: 0,
              duration: 0,
              color,
            };
          }
          acc[status_alarm].count += 1;
          acc[status_alarm].duration += duration_seconds;
          return acc;
        }, {})
      ).sort((a, b) => b.duration - a.duration).map((item, index) => ({
        no: index + 1,
        color: item.color,
        alarm: item.alarm,
        count: item.count,
        duration: item.duration,
        time: new Date(item.duration * 1000).toISOString().substr(11, 8),
      }));
    }

    const dataChart = generateData(data[0]);

    const summaryAlarm = summarize(dataChart);
    // console.log(summaryAlarm)
    res.json({ data: dataChart, dataAlarm: summaryAlarm, success: true });
  } catch (error) {
    res.json({ data: error, dataAlarm: [], success: false });
  }
});

router.get("/get_production_analysis_by_mc/:mc_no/:date", async (req, res) => {
  const { mc_no, date } = req.params;
  const mc = Number(mc_no.slice(-2))
  const calc = (mc % 2 === 0) ? mc/2 : (mc+1)/2
  const calc_mc_no = mc_no.slice(0,3) + String(calc).padStart(2, '0')
  // console.log(mc_no)

  const query = (mc % 2 === 0) ? `
    ${COLUMN_TOTAL_FRONT} AS prod_total,
    ${COLUMN_OK_FRONT} AS prod_ok,
    ${COLUMN_NG_FRONT} AS prod_ng,
  ` : `
    ${COLUMN_TOTAL_REAR} AS prod_total,
    ${COLUMN_OK_REAR} AS prod_ok,
    ${COLUMN_NG_REAR} AS [prod_ng],
  `

  const data = await dbms.query(`
      WITH [data] As (
        SELECT 
          p.[registered],
          CONVERT(varchar, p.[registered], 8) AS TIME,
          '${mc_no}' AS [mc_no],
          ${query}
          FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 7, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') AS [mfg_date],
          FORMAT(p.registered, 'HH:mm') AS cat_time
        FROM ${DATABASE_PROD} p
        WHERE p.mc_no = '${calc_mc_no}'
        AND FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 7, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') = '${date}'
      ),
      [master] AS (
        SELECT *,
          CAST([registered] AS date) AS date_regis,
          LEAD(CAST([registered] AS date)) OVER (ORDER BY [registered]) AS next_regis
        FROM [nat_mc_assy_ant_new].[dbo].[DATA_MASTER_ANT]
        WHERE mc_no = '${mc_no}'
      )
      SELECT 
        d.*,
          [part_no],
          [target_ct],
          [target_utl],
          [target_yield],
          [target_special],
          [ring_factor]
      FROM [data] d
      INNER JOIN [master] m ON d.[mc_no] = m.[mc_no]
      WHERE ('${date}' BETWEEN date_regis AND next_regis) OR ('${date}' >= date_regis AND next_regis IS NULL)
      ORDER BY registered ASC
  `);

  const result = calculateShifts(data[0], date);
  res.json({ success: true, data: result });
});

module.exports = router;
