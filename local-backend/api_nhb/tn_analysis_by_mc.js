const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nhb");
// const moment = require("moment");
const moment = require("moment-timezone");

// MASTER MACHINE NO. ASSY
router.get("/master_machine_tn", async (req, res) => {
  try {
    let master = await dbms.query(`
        SELECT DISTINCT(UPPER(mc_no)) AS mc_no
        FROM [nhbtn_db_mes].[dbo].[DATA_PRODUCTION]
        ORDER BY mc_no ASC
        `);

    res.json({ data: master[0], success: true, message: "ok" });
  } catch (error) {
    console.error("API Error in /machines: ", error);
    res
      .status(500)
      .json({ data: [], success: false, message: "Internal Server Error" });
  }
});

// MBR → PRODUCTION BY HOUR
router.get("/tn_production_hour_by_mc/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;

    let data = await dbms.query(`
             SELECT [registered],
                   convert(varchar, [registered], 8) AS TIME ,
                   format(iif(DATEPART(HOUR, [registered]) < 7, dateadd(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') AS [mfg_date] ,
                   [mc_no],
                   [TOTAL_CNT] AS dairy_ok,
                   [TOTAL_CNT] AS dairy_total ,
                   [CYCLETIME] AS [cycle_t] ,
                   CASE
                       WHEN [TOTAL_CNT]=0 THEN 0
                       ELSE cast(([TOTAL_CNT]/[TOTAL_CNT])*100 AS decimal(20, 2))
                   END AS yield,
                   FORMAT(registered, 'HH:mm') AS cat_time
            FROM [nhbtn_db_mes].[dbo].[DATA_PRODUCTION]
            WHERE mc_no = '${mc_no}'
              AND FORMAT(IIF(DATEPART(HOUR, [registered]) < 7, DATEADD(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') = '${date}'
            ORDER BY registered ASC
            `);

    if (data[0].length > 0) {
      arrayData = data[0];
      arrayData_yield = data[0];
      let calData = [];
      const index_data = arrayData[0].dairy_total;
      await calData.push(index_data);

      for (let i = 0; i < arrayData.length - 1; i++) {
        await calData.push(
          arrayData[i + 1].dairy_total - arrayData[i].dairy_total < 0
            ? 0
            : arrayData[i + 1].dairy_total - arrayData[i].dairy_total
        );
      }

      res.json({
        data: calData,
        data_raw: data[0],
        success: true,
        message: "ok",
      });
    } else {
      res.json({ data: [], data_raw: data[0], success: true, message: "ok" });
    }
  } catch (error) {
    // console.log(error);
    res
      .status(500)
      .json({ data: [], success: false, message: "Internal Server Error" });
  }
});

router.get("/status_mbr/:mc_no/:date", async (req, res) => {
  try {
    let { mc_no, date } = req.params;
    let dateTomarrow = moment(date)
      .add(1, "day")
      .endOf("day")
      .format("YYYY-MM-DD");

    let data = await dbms.query(`
      DECLARE @start_date DATETIME = '${date} 07:00';
      DECLARE @end_date DATETIME = '${dateTomarrow} 07:00';

      WITH [alarm_base] AS (
          -- สร้างช่วงเวลา alarm จาก occurred → restored
          SELECT
              UPPER([mc_no]) AS [mc_no],
              UPPER([topic_group]) AS [process],
              UPPER([topic]) AS [alarm_base],
              [occurred] AS [occurred_start],
              [restored] AS [occurred_end]
          FROM [nhbtn_db_mes].[dbo].[DATA_ALARMLIST]
          WHERE [occurred] BETWEEN @start_date AND @end_date
          AND mc_no = '${mc_no}'
      ),

      [mcstatus_base] AS (
          -- 🔹 สร้างช่วงเวลาสถานะเครื่องจาก status log
          SELECT
              UPPER([mc_no]) AS [mc_no],
              'MC' AS [process],
              UPPER([status]) AS [alarm_base],
              [registered] AS [occurred_start],
              LEAD([registered]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [occurred_end]
          FROM [nhbtn_db_mes].[dbo].[DATA_MCSTATUS]
          WHERE [registered] BETWEEN @start_date AND @end_date
          AND mc_no = '${mc_no}'
      ),

      [combine_result] AS (
          -- 🔸 รวม alarm และ mcstatus เข้าด้วยกัน
          SELECT * FROM [alarm_base]
          UNION ALL
          SELECT * FROM [mcstatus_base]
      ),

      [fill_stop] AS (
          -- 🔸 เติม STOP สำหรับช่องว่างระหว่าง alarm / run ต่าง ๆ
          SELECT
              [mc_no],
              [process],
              'STOP' AS [alarm_base],
              [occurred_end] AS [occurred_start],
              LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [occurred_end]
          FROM [combine_result]
      ),

      [union_all_result] AS (
          -- 🔹 รวมทั้งหมด: ALARM + STATUS + STOP
          SELECT * FROM [combine_result]
          UNION ALL
          SELECT * FROM [fill_stop]
      ),

      [edit_time_result] AS (
          -- 🔸 ปัดเวลาให้อยู่ในช่วง start-end ที่กำหนด
          SELECT
              [mc_no],
              [process],
              [alarm_base],
              CASE 
                  WHEN [occurred_start] < @start_date THEN @start_date
                  ELSE [occurred_start]
              END AS [occurred_start],
              CASE 
                  WHEN [occurred_end] > @end_date OR [occurred_end] IS NULL THEN @end_date
                  ELSE [occurred_end]
              END AS [occurred_end]
          FROM [union_all_result]
      ),

      [filter_result] AS (
          -- 🔹 ลบ record ที่เวลาผิดหรือว่าง
          SELECT *
          FROM [edit_time_result]
          WHERE [occurred_end] > [occurred_start]
      )

      -- ✅ ผลลัพธ์สุดท้าย
      SELECT
          [mc_no],
          [process],
          [alarm_base],
          [occurred_start],
          [occurred_end],
          DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
      FROM [filter_result]
      ORDER BY [mc_no], [occurred_start];
`);
    const colorMap = {};
    const palette = [
      "#F59127",
      "#3cb44b",
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
      if (status === "RUN") return "#16C809";
      if (status === "STOP") return "#F40B0B";
      if (!colorMap[status]) {
        colorMap[status] =
          palette[Object.keys(colorMap).length % palette.length];
      }
      return colorMap[status];
    };
    function generateData(raw) {
      return raw.map((item) => {
        const start = moment(item.occurred_start)
          .utc()
          .format("YYYY-MM-DD HH:mm:ss");
        const end = moment(item.occurred_end)
          .utc()
          .format("YYYY-MM-DD HH:mm:ss");
        const color = getColor(item.alarm_base);

        return {
          ...item,
          color, // ✅ เพิ่ม color ที่ match alarm_base
          name: item.alarm_base,
          value: [
            0,
            start,
            end,
            item.duration_seconds,
            item.occurred_start,
            item.occurred_end,
          ],
          itemStyle: { color },
        };
      });
    }

    // ========================================
    // Summary ตาม alarm_base (ใช้ data[0] ที่มี color แล้ว)
    // ========================================
    function summarize(data) {
      return Object.values(
        data.reduce((acc, { alarm_base, duration_seconds, color }) => {
          if (!acc[alarm_base]) {
            acc[alarm_base] = {
              alarm: alarm_base,
              count: 0,
              duration: 0,
              color,
            };
          }
          acc[alarm_base].count += 1;
          acc[alarm_base].duration += duration_seconds;
          return acc;
        }, {})
      ).map((item, index) => ({
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
    res.json({ data: dataChart, dataAlarm: summaryAlarm, success: true });
  } catch (error) {
    // console.log(error);
    res.json({ data: error, dataAlarm: [], success: false });
  }
});

const calcTargetProd = (timeSeconds, row) => {
  if (row.target_special && row.target_special !== "") {
    return Number(row.target_special);
  }
  return (
    (timeSeconds / row.target_ct) *
    (row.target_utl / 100) *
    (row.target_yield / 100) *
    row.ring_factor
  );
};

function calculateShifts(data, date) {
  let M = null;
  let N = null;
  let All = null;

  const now = new Date();
  const todayStr = moment().format("YYYY-MM-DD");

  // -------------------------------------------------
  // ถ้าวันที่ = วันนี้  → คำนวณ All แบบ real-time
  // -------------------------------------------------
  if (date === todayStr) {
    const A_start = data.find((r) => r.TIME.startsWith("06:"));
    const nowHour = now.getHours();
    const nowStr = `${nowHour.toString().padStart(2, "0")}:`;
    const A_end =
      data.find((r) => r.TIME.startsWith(nowStr)) || data[data.length - 1];

    if (A_start && A_end) {
      const diff_total = A_end.prod_total;
      const diff_ok = A_end.prod_ok;
      const seconds = (nowHour - 6) * 3600; // ตั้งแต่ 6:00 ถึงตอนนี้

      const target_prod = calcTargetProd(seconds, A_start);
      const utl = (diff_total/ (seconds / A_end.target_ct)) * 100 * A_end.ring_factor
      const ach = (diff_total / target_prod) * 100;
      const yieldVal = (diff_ok / diff_total) * 100;

      All = {
        ...A_end,
        prod_total: diff_total,
        prod_ok: diff_ok,
        target_prod: Math.round(target_prod),
        utl: utl.toFixed(2),
        ach: ach.toFixed(2),
        yield: yieldVal.toFixed(2),
      };
    }
  }
  // -------------------------------------------------
  // ถ้าเป็นวันก่อนหน้า  → คำนวณ M, N และรวม All
  // -------------------------------------------------
  else {
    // ----------------- M -----------------
    const Mrow = data.find((r) => r.TIME.startsWith("17:"));
    if (Mrow) {
      const seconds = 12 * 3600; // 06:00 - 17:00
      const target_prod = calcTargetProd(seconds, Mrow);
      const utl = ((Mrow.prod_total)/ (seconds / Mrow.target_ct)) * 100 * Mrow.ring_factor
      const ach = (Mrow.prod_total / target_prod) * 100;
      const yieldVal = (Mrow.prod_ok / Mrow.prod_total) * 100;

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
    const N_end = data.find((r) => r.TIME.startsWith("05:"));
    if (N_start && N_end) {
      const diff_total = N_end.prod_total - N_start.prod_total;
      const diff_ok = N_end.prod_ok - N_start.prod_ok;
      const diff_ng = N_end.prod_ng - N_start.prod_ng;
      const seconds = 12 * 3600; // 18:00 - 05:00 ≈ 11 hr
      const target_prod = calcTargetProd(seconds, N_start);
      const utl = (diff_total/ (seconds / N_start.target_ct)) * 100 * N_start.ring_factor
      const ach = (diff_total / target_prod) * 100;
      const yieldVal = (diff_ok / diff_total) * 100;

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
      const utl = (diff_total/ (seconds / M.target_ct)) * 100 * M.ring_factor

      const ach = (diff_total / target_prod) * 100;
      const yieldVal = (diff_ok / diff_total) * 100;

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

// --------------------------------------------
// ตัวอย่างการใช้งานใน Node API
// --------------------------------------------
router.get("/get_production_analysis_by_mc/:mc_no/:date", async (req, res) => {
  const { mc_no, date } = req.params;
  const data = await dbms.query(`
      SELECT 
        p.[registered],
        CONVERT(varchar, p.[registered], 8) AS TIME,
        [model],
        [c1_ok]+[c2_ok]+[c3_ok]+[c4_ok]+[c5_ok]+[c1_ng]+[c2_ng]+[c3_ng]+[c4_ng]+[c5_ng] AS prod_total,
        [c1_ok]+[c2_ok]+[c3_ok]+[c4_ok]+[c5_ok] AS prod_ok,
        [c1_ng]+[c2_ng]+[c3_ng]+[c4_ng]+[c5_ng] AS prod_ng,
        FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 7, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') AS [mfg_date],
        UPPER(p.[mc_no]) AS mc_no,
        FORMAT(p.registered, 'HH:mm') AS cat_time,
        [part_no],
        [target_ct],
        [target_utl],
        [target_yield],
        [target_special],
        [ring_factor]
            FROM [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR] p
			LEFT JOIN [nat_mc_assy_mbr].[dbo].[DATA_MASTER_MBR] m ON p.mc_no = m.mc_no
      WHERE p.mc_no = '${mc_no}'
        AND FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 6, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') = '${date}'
      ORDER BY registered ASC
    `);

  const result = calculateShifts(data[0], date);
  res.json({ success: true, data: result });
});

module.exports = router;
