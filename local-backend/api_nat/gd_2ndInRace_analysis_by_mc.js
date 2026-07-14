const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment-timezone");
const getData = require("../api_nat/analysis_2gd")

const DATABASE_PROD = "[nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD]";
const DATABASE_ALARM = "[nat_mc_mcshop_2gd].[dbo].[DATA_ALARMLIS_2GD]";
const DATABASE_STATUS = "[nat_mc_mcshop_2gd].[dbo].[DATA_MCSTATUS_2GD]";
const DATABASE_IOT = "[nat_mc_mcshop_2gd].[dbo].[MONITOR_IOT]";
const DATABASE_MASTER = "[nat_mc_mcshop_2gd].[dbo].[DATA_MASTER_2GD]";

const COLUMN_OK = "[prod_total]";
const COLUMN_NG = "0";
const COLUMN_TOTAL = `(${COLUMN_OK} + ${COLUMN_NG})`;
const COLUMN_CT = "[eachct]";

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
    const A_start = data.find((r) => r.TIME.startsWith("08:"));
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
    const Mrow = data.find((r) => r.TIME.startsWith("19:"));
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
    const N_start = data.find((r) => r.TIME.startsWith("19:"));
    const N_end = data.find((r) => r.TIME.startsWith("07:"));
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
        SELECT DISTINCT(UPPER(mc_no)) AS mc_no
        FROM ${DATABASE_PROD}
        WHERE [mc_no] LIKE 'IR%R' -- มีเฉพาะเครื่อง 2nd In Race
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
    const result = await getData.productionByHour(DATABASE_PROD, COLUMN_OK, COLUMN_TOTAL, COLUMN_CT, mc_no, date)
    res.json(result);
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

router.get("/status/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    const result = await getData.status(DATABASE_PROD, DATABASE_STATUS, DATABASE_IOT, mc_no, date)
    res.json(result);
  } catch (error) {
    res.json({ data: error, dataAlarm: [], success: false });
  }
});

router.get("/get_production_analysis_by_mc/:mc_no/:date", async (req, res) => {
  try {
    const { mc_no, date } = req.params;
    const result = await getData.productionDaily(DATABASE_PROD, DATABASE_MASTER, COLUMN_TOTAL, COLUMN_OK, COLUMN_NG, mc_no, date)
    res.json(result);
  } catch (error) {
    res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
