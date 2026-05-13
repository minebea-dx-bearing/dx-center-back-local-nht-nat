const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nht");
const moment = require("moment-timezone");
const { getStatusTimeline } = require("../util/statusAnalyzer");
const { generateData, summarize, calcTargetProd } = require("../util/analysisChartUtils");

const DATABASE_PROD = "[data_machine_alu].[dbo].[DATA_PRODUCTION_ALU]";
const DATABASE_ALARM = "[data_machine_alu].[dbo].[DATA_ALARMLIS_ALU]";
const DATABASE_IOT = "[data_machine_alu].[dbo].[MONITOR_IOT]";
const DATABASE_MASTER = "[data_machine_alu].[dbo].[DATA_MASTER_ALU]";

const COLUMN_OK = "[prod_cnt_qty]";
const COLUMN_NG = "0";
const COLUMN_TOTAL = `(${COLUMN_OK} + ${COLUMN_NG})`;
const COLUMN_CT = "[cycletime]";
const COLUMN_MODEL = `'no model'`;

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
      const utl = (diff_total / ((seconds / A_end.target_ct) * A_end.ring_factor)) * 100;
      const ach = (diff_total / target_prod) * 100 || 0.0;
      const yieldVal = (diff_ok / diff_total) * 100 || 0.0;

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
      const utl = (Mrow.prod_total / ((seconds / Mrow.target_ct) * Mrow.ring_factor)) * 100;
      const ach = (Mrow.prod_total / target_prod) * 100 || 0.0;
      const yieldVal = (Mrow.prod_ok / Mrow.prod_total) * 100 || 0.0;

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
      const utl = (diff_total / ((seconds / N_start.target_ct) * N_start.ring_factor)) * 100;
      const ach = (diff_total / target_prod) * 100 || 0.0;
      const yieldVal = (diff_ok / diff_total) * 100 || 0.0;

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
      const utl = (diff_total / ((seconds / M.target_ct) * M.ring_factor)) * 100;

      const ach = (diff_total / target_prod) * 100 || 0.0;
      const yieldVal = (diff_ok / diff_total) * 100 || 0.0;

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
};

// MASTER MACHINE NO.
router.get("/master_machine", async (req, res) => {
  try {
    let master = await dbms.query(
      `
        SELECT DISTINCT(UPPER(mc_no)) AS mc_no
        FROM ${DATABASE_PROD}
        ORDER BY mc_no ASC
      `,
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

    let data = await dbms.query(
      `
          SELECT [registered],
              convert(varchar, [registered], 8) AS TIME ,
              ${COLUMN_MODEL} AS [model] ,
              format(iif(DATEPART(HOUR, [registered]) < 7, dateadd(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') AS [mfg_date] ,
              [mc_no],
              ${COLUMN_OK} AS daily_ok,
              ${COLUMN_TOTAL} AS daily_total,
              ${COLUMN_CT} AS [cycle_t],
              CASE 
                    WHEN ${COLUMN_TOTAL} = 0 THEN 0
                    ELSE cast((${COLUMN_OK} * 1.0 / ${COLUMN_TOTAL}) * 100 AS decimal(20, 2)) -- คูณ 1.0 เพื่อป้องกัน Integer Division (หารแล้วทศนิยมหาย)
              END AS yield,
              FORMAT(registered, 'HH:mm') AS cat_time
          FROM ${DATABASE_PROD}
          WHERE mc_no = :mc_no
          AND FORMAT(IIF(DATEPART(HOUR, [registered]) < 7, DATEADD(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') = :date
          ORDER BY registered ASC
      `,
      {
        replacements: { mc_no, date },
      },
    );

    if (data[0].length > 0) {
      arrayData = data[0];
      arrayData_yield = data[0];
      let calData = [];
      const index_data = arrayData[0].daily_total;
      await calData.push(index_data);

      for (let i = 0; i < arrayData.length - 1; i++) {
        await calData.push(arrayData[i + 1].daily_total - arrayData[i].daily_total < 0 ? 0 : arrayData[i + 1].daily_total - arrayData[i].daily_total);
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
    const result = await getStatusTimeline(dbms, mc_no, date, {
      databaseAlarm: DATABASE_ALARM,
      databaseIot: DATABASE_IOT,
    });
    const dataChart = generateData(result);

    const summaryAlarm = summarize(dataChart);
    res.json({ data: dataChart, dataAlarm: summaryAlarm, success: true });
  } catch (error) {
    res.json({ data: error, dataAlarm: [], success: false });
  }
});

router.get("/get_production_analysis_by_mc/:mc_no/:date", async (req, res) => {
  const { mc_no, date } = req.params;
  const data = await dbms.query(
    `
      SELECT 
        p.[registered],
        CONVERT(varchar, p.[registered], 8) AS TIME,
        ${COLUMN_MODEL} AS [model],
        ${COLUMN_TOTAL} AS prod_total,
        ${COLUMN_OK} AS prod_ok,
        ${COLUMN_NG} AS prod_ng,
        FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 7, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') AS [mfg_date],
        UPPER(p.[mc_no]) AS mc_no,
        FORMAT(p.registered, 'HH:mm') AS cat_time,
        [part_no],
        [target_ct],
        [target_utl],
        [target_yield],
        [target_special],
        [ring_factor]
          FROM ${DATABASE_PROD} p
          LEFT JOIN ${DATABASE_MASTER} m ON p.mc_no = m.mc_no
      WHERE p.mc_no = :mc_no
      AND FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 7, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') = :date
      ORDER BY registered ASC
    `,
    {
      replacements: { mc_no, date },
    },
  );

  const result = calculateShifts(data[0], date);
  res.json({ success: true, data: result });
});

module.exports = router;
