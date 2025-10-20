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
            SELECT
                *,
                ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_PROD}
            WHERE [registered] >= DATEADD(day, -3, GETDATE())
        ),
        LatestAlarm AS (
            SELECT
                [mc_no],
                [alarm],
                [occurred],
                ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [occurred] DESC) AS rn
            FROM ${DATABASE_ALARM}
            WHERE
                UPPER([alarm]) LIKE '%RUN%'
                AND [occurred] >= DATEADD(day, -3, GETDATE())
        )
        SELECT 
            p.*, -- เลือกทุกคอลัมน์จาก Production
            ISNULL(a.[alarm], 'no data') AS [alarm],
            a.[occurred]
        FROM LatestProduction p
        LEFT JOIN LatestAlarm a 
            ON p.[mc_no] = a.[mc_no]
            AND a.rn = 1
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