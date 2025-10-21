/**
 * ฟังก์ชันสำหรับ Query ข้อมูล Master ของเครื่องจักรล่าสุด
 * @param {object} dbms - Sequelize instance สำหรับการเชื่อมต่อฐานข้อมูล
 * @param {string} DATABASE_PROD - ชื่อตาราง Production
 * @param {string} DATABASE_ALARM - ชื่อตาราง Alarm
 * @returns {Promise<Array>} - Array ของข้อมูลเครื่องจักร
 */
const master_mc_no = async (dbms, DATABASE_PROD, DATABASE_ALARM) => {
  try {
    const result = await dbms.query(
      `
        WITH LatestProduction AS (
            -- CTE นี้ยังคงเหมือนเดิม: ดึงข้อมูล production ล่าสุดของแต่ละเครื่อง
            SELECT
                *,
                ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_PROD}
            WHERE [registered] >= DATEADD(day, -3, GETDATE())
        ),
        LatestAlarm AS (
            -- CTE นี้ถูกปรับปรุงเล็กน้อย: เพิ่ม alarm_type เพื่อระบุประเภทให้ชัดเจน
            SELECT
                [mc_no],
                [alarm],
                [occurred],
                -- สร้างคอลัมน์ alarm_type เพื่อใช้ในขั้นตอนถัดไป
                CASE
                    WHEN UPPER([alarm]) LIKE '%REAR%' THEN 'REAR'
                    WHEN UPPER([alarm]) LIKE '%FRONT%' THEN 'FRONT'
                END AS alarm_type,
                ROW_NUMBER() OVER (
                    PARTITION BY
                        [mc_no],
                        CASE
                            WHEN UPPER([alarm]) LIKE '%REAR%' THEN 'REAR'
                            WHEN UPPER([alarm]) LIKE '%FRONT%' THEN 'FRONT'
                        END
                    ORDER BY [occurred] DESC
                ) AS rn
            FROM ${DATABASE_ALARM}
            WHERE
                UPPER([alarm]) LIKE '%RUN%'
                AND [occurred] >= DATEADD(day, -3, GETDATE())
        ),
        PivotedAlarms AS (
            -- CTE ใหม่สำหรับ Pivot ข้อมูล: เปลี่ยน alarm จากแถวเป็นคอลัมน์
            SELECT
                [mc_no],
                -- ใช้ Conditional Aggregation เพื่อสร้างคอลัมน์ใหม่
                MAX(CASE WHEN alarm_type = 'FRONT' THEN [alarm] END) AS alarm_front,
                MAX(CASE WHEN alarm_type = 'FRONT' THEN [occurred] END) AS occurred_front,
                MAX(CASE WHEN alarm_type = 'REAR' THEN [alarm] END) AS alarm_rear,
                MAX(CASE WHEN alarm_type = 'REAR' THEN [occurred] END) AS occurred_rear
            FROM LatestAlarm
            WHERE rn = 1  -- เอาเฉพาะ alarm ล่าสุดของแต่ละประเภท
            GROUP BY [mc_no] -- รวมข้อมูลให้เหลือ mc_no ละ 1 แถว
        )
        -- Final SELECT: รวมข้อมูล Production ล่าสุดกับ Alarms ที่ Pivot แล้ว
        SELECT 
            p.*, -- เลือกทุกคอลัมน์จาก Production
            ISNULL(a.alarm_front, 'no data') AS alarm_front,
            a.occurred_front,
            ISNULL(a.alarm_rear, 'no data') AS alarm_rear,
            a.occurred_rear
        FROM LatestProduction p
        LEFT JOIN PivotedAlarms a ON p.[mc_no] = a.[mc_no]
        WHERE p.rn = 1
        ORDER BY p.[mc_no];
      `
    );

    // dbms.query จะคืนค่าเป็น [results, metadata]
    return result[0];
  } catch (error) {
    console.error("Database Query Error in machineMasterQuery: ", error);
    return []; // คืนค่าเป็น Array ว่างหากเกิด Error
  }
};

// Export ฟังก์ชันนี้ออกไปเพื่อให้ไฟล์อื่นเรียกใช้ได้
module.exports = master_mc_no;