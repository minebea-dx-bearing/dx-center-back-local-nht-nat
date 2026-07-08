const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const moment = require("moment-timezone");

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

const productionByHour = async (DATABASE_PROD, COLUMN_OK, COLUMN_TOTAL, COLUMN_CT, mc_no, date) => {
    try {
      let data = await dbms.query(`
          SELECT [registered],
              convert(varchar, [registered], 8) AS TIME ,
              [model] ,
              format(iif(DATEPART(HOUR, [registered]) < 8, dateadd(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') AS [mfg_date] ,
              [mc_no],
              ${COLUMN_OK} AS daily_ok,
              ${COLUMN_TOTAL} AS daily_total,
              ${COLUMN_CT} AS [cycle_t],
              CASE 
                    WHEN ${COLUMN_TOTAL} = 0 THEN 0
                    ELSE cast(((${COLUMN_OK}) * 1.0 / ${COLUMN_TOTAL}) * 100 AS decimal(20, 2)) -- คูณ 1.0 เพื่อป้องกัน Integer Division (หารแล้วทศนิยมหาย)
              END AS yield,
              FORMAT(registered, 'HH:mm') AS cat_time
          FROM ${DATABASE_PROD}
          WHERE mc_no = '${mc_no}'
          AND FORMAT(IIF(DATEPART(HOUR, [registered]) < 8, DATEADD(DAY, -1, [registered]), [registered]), 'yyyy-MM-dd') = '${date}'
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
          "07:00",
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
  
        return{
          data: calData,
          yield: yieldData,
          data_raw: data[0],
          data_date: finalDate,
          success: true,
          message: "ok",
        };
      } else {
        return{ data: [], data_raw: data[0], success: true, message: "ok" };
      }
    } catch (error) {
      console.log("Can't get data productionByHour: ",error);
      return error.message;
    }
}

const status = async (DATABASE_PROD, DATABASE_STATUS, DATABASE_IOT, mc_no, date) =>{
    try {
      let dateTomarrow = moment(date).add(1, "day").endOf("day").format("YYYY-MM-DD");
  
      let data = await dbms.query(`
          DECLARE @start_date DATETIME = '${date} 07:00'; -- เปลี่ยนวันที่ด้วย
          DECLARE @end_date DATETIME = '${dateTomarrow} 07:00'; -- เปลี่ยนวันที่ด้วย
          DECLARE @start_date_before DATETIME = DATEADD(HOUR, -1, @start_date);
          DECLARE @end_min_check_status DATETIME = DATEADD(MINUTE, 1, @start_date);

          -------------------------------------------------------------------
          -- STEP 1: กวาดข้อมูลจากตารางหลักมาลง Temp Table (ใส่ COLLATE ป้องกัน Error)
          -------------------------------------------------------------------
          IF OBJECT_ID('tempdb..#TempStatus') IS NOT NULL DROP TABLE #TempStatus;
          SELECT 
              [mc_no] COLLATE DATABASE_DEFAULT AS [mc_no], 
              [occurred],
              [mc_status] COLLATE DATABASE_DEFAULT AS [mc_status], 
              [occurred] AS [occurred_start]
          INTO #TempStatus
          FROM ${DATABASE_STATUS}
          WHERE [occurred] >= DATEADD(DAY, -1, @start_date) AND [occurred] <= @end_date;

          CREATE CLUSTERED INDEX IX_TempStatus ON #TempStatus(mc_no, occurred_start);

          IF OBJECT_ID('tempdb..#TempMonitor') IS NOT NULL DROP TABLE #TempMonitor;
          SELECT
              [mc_no] COLLATE DATABASE_DEFAULT AS [mc_no], 
              [registered], CAST([broker] AS FLOAT) AS [broker],
              LAG(CAST([broker] AS FLOAT)) OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [broker_prv]
          INTO #TempMonitor
          FROM ${DATABASE_IOT}
          WHERE [registered] BETWEEN @start_date_before AND @end_date;

          CREATE CLUSTERED INDEX IX_TempMonitor ON #TempMonitor(mc_no, registered);
          -------------------------------------------------------------------
          -- STEP 2: จับข้อมูลมา Merge กันทีละ Step (จัดลำดับใหม่เพื่อดึง Status ย้อนหลังให้ถูกต้อง)
          -------------------------------------------------------------------
          IF OBJECT_ID('tempdb..#TempMerge') IS NOT NULL DROP TABLE #TempMerge;
          CREATE TABLE #TempMerge (
              mc_no NVARCHAR(50) COLLATE DATABASE_DEFAULT, 
              mc_status NVARCHAR(50) COLLATE DATABASE_DEFAULT, 
              occurred_start DATETIME
          );

          -- 2.1 เอา Status ปกติในช่วงเวลาของวันนี้ใส่ลงไป
          INSERT INTO #TempMerge (mc_no, mc_status, occurred_start)
          SELECT mc_no, mc_status, occurred_start
          FROM #TempStatus WHERE occurred_start BETWEEN @start_date AND @end_date;

          -- 2.2 แทรก Connection Lost จาก IOT (กรณีกล่องส่ง 0)
          INSERT INTO #TempMerge (mc_no, mc_status, occurred_start)
          SELECT mc_no, 'connection lost', registered
          FROM #TempMonitor
          WHERE (broker_prv = 1 AND broker = 0 AND registered BETWEEN @start_date AND @end_date)
          OR (registered BETWEEN @start_date AND @end_min_check_status AND broker_prv = 0 AND broker = 0);

          -- 2.3 แทรก Recovery (กรณีกล่องกลับมาส่ง 1 แต่ไม่มี Status)
          INSERT INTO #TempMerge (mc_no, mc_status, occurred_start)
          SELECT 
              m.mc_no,
              -- เมื่อกล่องเปลี่ยนจาก 0 เป็น 1 แต่ไม่มี status ส่งมาในรอบ +- 5 นาที ให้ดึง status ล่าสุดก่อนหน้านั้นมาใส่
              CASE 
                  WHEN NOT EXISTS (
                      SELECT 1 FROM #TempStatus s
                      WHERE s.mc_no = m.mc_no
                      AND (s.occurred_start > m.registered OR s.occurred_start BETWEEN DATEADD(MINUTE, -5, m.registered) AND DATEADD(MINUTE, 5, m.registered))
                      AND s.occurred_start <= @end_date
                  ) THEN 'connection lost' --ถ้าหลังจาก broker กลับมาเป็น 1 แต่ไม่มี status ส่งมาเลย ให้เป็น connection lost
                  ELSE ISNULL(last_s.mc_status, 'connection lost')
              END AS mc_status,
              m.registered
          FROM #TempMonitor m
          OUTER APPLY (
              SELECT TOP 1 
                  s.mc_status,
                  -- แตกตัวเช็กแยกต่างหากว่า ตัวล่าสุดที่เจอตัวนี้ อยู่ในพิกัด +- 5 นาทีหรือไม่
                  IIF(s.occurred_start BETWEEN DATEADD(MINUTE, -5, m.registered) AND DATEADD(MINUTE, 5, m.registered), 1, 0) AS is_near
              FROM #TempStatus s
              WHERE s.mc_no = m.mc_no 
              AND s.occurred_start <= DATEADD(MINUTE, 5, m.registered)
              -- ดึงข้อมูลเก่าล่าสุดย้อนหลังได้ 1 วันเต็ม (ข้อมูลถูกเตรียมไว้ใน #TempStatus ตั้งแต่แรกแล้ว)
              AND s.occurred_start >= DATEADD(DAY, -1, m.registered) 
              ORDER BY s.occurred_start DESC
          ) last_s
          WHERE m.broker_prv = 0 AND m.broker = 1 
          AND m.registered BETWEEN @start_date AND @end_date
          AND (last_s.is_near IS NULL OR last_s.is_near = 0);

          -- 2.4 แทรก First Status (ดึงตัวล่าสุดที่ค้างอยู่จาก 7 วันก่อนหน้า มาเป็นเวลาเริ่มกะ)
          WITH [first_status] AS (
              SELECT mc_no, mc_status, CAST(CAST(@start_date AS DATE) AS DATETIME) AS occurred_start,
                  ROW_NUMBER() OVER (PARTITION BY mc_no ORDER BY occurred_start DESC) as rn
              FROM #TempStatus 
              WHERE occurred_start < @start_date AND occurred_start >= DATEADD(DAY, -1, @start_date)
          )
          INSERT INTO #TempMerge (mc_no, mc_status, occurred_start)
          SELECT f.mc_no, f.mc_status, f.occurred_start
          FROM [first_status] f
          WHERE f.rn = 1 
          -- เช็คเพื่อความชัวร์ว่า: IoT ไม่ได้แจ้งเตือนว่ากล่องดับ 0 ตั้งแต่เปิดกะ (ถ้ายืนยันว่าดับจริง จะไม่เอาอดีตมาทับ)
          AND NOT EXISTS (
              SELECT 1 FROM #TempMerge m 
              WHERE m.mc_no = f.mc_no 
                  AND m.mc_status = 'connection lost' 
                  AND m.occurred_start BETWEEN @start_date AND @end_min_check_status
          );

          -- 2.5 แทรก Connection Lost สำหรับเครื่องที่ "หายสาบสูญ" จริงๆ
          -- (คือวันนี้ไม่มี Log อะไรเลย, และย้อนหลังไป 7 วัน ก็ไม่มี Log เหลืออยู่เลย)
          INSERT INTO #TempMerge (mc_no, mc_status, occurred_start)
          SELECT a.mc_no, 'connection lost', @start_date
          FROM (SELECT DISTINCT mc_no COLLATE DATABASE_DEFAULT AS mc_no FROM ${DATABASE_PROD} WHERE registered >= DATEADD(DAY, -1, @start_date)) a
          WHERE NOT EXISTS (
              -- เช็คจากกระบะทรายเลยว่าเครื่องนี้มี Status (ไม่ว่าจะของวันนี้หรืออดีต 7 วัน) ติดมาบ้างไหม ถ้าไม่มีเลยค่อยฟ้อง lost
              SELECT 1 FROM #TempMerge m 
              WHERE m.mc_no = a.mc_no
          );

          -------------------------------------------------------------------
          -- STEP 3: ประมวลผลขั้นสุดท้าย (คำนวณวินาที และกรุ๊ปปิ้ง)
          -------------------------------------------------------------------
          WITH [set_occurred] AS (
              SELECT *, LEAD(occurred_start) OVER (PARTITION BY mc_no ORDER BY occurred_start) AS occurred_end
              FROM #TempMerge
          ),
          [set_time] AS (
              SELECT UPPER(mc_no) AS mc_no, mc_status AS [status_alarm],
                  CASE WHEN (occurred_start < @start_date) OR (mc_status = 'connection lost' AND occurred_start BETWEEN @start_date AND @end_min_check_status) THEN @start_date ELSE occurred_start END AS occurred_start,
                  CASE 
                    WHEN occurred_end IS NULL AND CAST(@start_date AS date) = CAST(GETDATE() AS date) THEN GETDATE()
                    WHEN (occurred_end IS NULL AND occurred_start BETWEEN @start_date AND @end_min_check_status) OR (occurred_end IS NULL) THEN @end_date 
                    ELSE occurred_end 
                  END AS occurred_end                
              FROM [set_occurred]
              WHERE (occurred_end > @start_date AND occurred_start < @end_date) OR mc_status = 'connection lost' OR occurred_end IS NULL
          ),
          [set_cl] AS (
              -- ถ้า [occurred_start] ไม่ได้เท่ากับ @start_date ก็ให้ทำเป็น connection lost
              SELECT * FROM [set_time]
              UNION ALL
              SELECT
                  [mc_no],
                  'connection lost' AS [status_alarm],
                  @start_date AS [occurred_start],
                  MIN([occurred_start]) AS [occurred_end]
              FROM [set_time]
              GROUP BY [mc_no]
              HAVING MIN([occurred_start]) > @start_date
          )
          SELECT 
            [mc_no],
            UPPER([status_alarm]) AS [status_alarm],
            [occurred_start],
            [occurred_end],
            DATEDIFF(SECOND, occurred_start, occurred_end) AS [duration_seconds]
          FROM [set_cl]
          WHERE [mc_no] = '${mc_no}'
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
      return{ data: dataChart, dataAlarm: summaryAlarm, success: true };
    } catch (error) {
      console.log("Can't get data status: ",error);
      return error.message;
    }
}

const productionDaily = async(DATABASE_PROD, DATABASE_MASTER, COLUMN_TOTAL, COLUMN_OK, COLUMN_NG, mc_no, date) => {
  try{
    const data = await dbms.query(`
      SELECT 
        p.[registered],
        CONVERT(varchar, p.[registered], 8) AS TIME,
        [model],
        ${COLUMN_TOTAL} AS prod_total,
        ${COLUMN_OK} AS prod_ok,
        ${COLUMN_NG} AS prod_ng,
        FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 8, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') AS [mfg_date],
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
      WHERE p.mc_no = '${mc_no}'
      AND FORMAT(IIF(DATEPART(HOUR, p.[registered]) < 8, DATEADD(DAY, -1, p.[registered]), p.[registered]), 'yyyy-MM-dd') = '${date}'
      ORDER BY registered ASC
    `);
  
    const result = calculateShifts(data[0], date);
    return{ success: true, data: result };
  }catch (error) {
    console.log("Can't get data productionDaily: ",error);
    return error.message;
  }
}

module.exports = {
  productionByHour,
  status,
  productionDaily
};
