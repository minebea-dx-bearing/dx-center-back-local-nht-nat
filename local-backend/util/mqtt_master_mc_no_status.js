/**
 * ฟังก์ชันสำหรับ Query ข้อมูล Master ของเครื่องจักรล่าสุด
 * @param {object} dbms - Sequelize instance สำหรับการเชื่อมต่อฐานข้อมูล
 * @param {string} DATABASE_PROD - ชื่อตาราง Production
 * @param {string} DATABASE_ALARM - ชื่อตาราง Alarm
 * @param {string} CONDITION - condition
 * @returns {Promise<Array>} - Array ของข้อมูลเครื่องจักร
 */
const master_mc_no_status = async (dbms, DATABASE_PROD, DATABASE_STATUS, DATABASE_MASTER, CONDITION) => {
  try {
    // let statusColumn = "[alarm]"; 

    // if (DATABASE_ALARM.includes('DATA_MCSTATUS')) { // สมมติตัวอย่างเงื่อนไข
    //     statusColumn = "[mc_status]";
    // }
    const result = await dbms.query(
      `
        WITH LatestProduction AS (
            SELECT
                *,
                ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_PROD}
            WHERE [registered] >= DATEADD(day, -3, GETDATE()) ${CONDITION}
        ),
        LatestAlarm AS (
            SELECT
                [mc_no],
                [mc_status],
                [occurred],
                ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [occurred] DESC) AS rn
            FROM ${DATABASE_STATUS}
            WHERE
                UPPER([mc_status]) LIKE '%RUN%'AND 
                [occurred] >= DATEADD(day, -3, GETDATE())
        ),
        MasterTarget AS (
            SELECT
              [mc_no],
              [part_no],
              [target_ct],
              [target_utl],
              [target_yield],
              [target_special],
	            [ring_factor],
              ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_MASTER}
          )
          SELECT 
              p.*, -- เลือกทุกคอลัมน์จาก Production
              ISNULL(a.[mc_status], 'no data') AS [alarm],
              a.[occurred],
              ISNULL(m.[part_no], 'no setup') AS [part_no],
              ISNULL(m.[target_ct], 0) AS [target_ct],
              ISNULL(m.[target_utl], 0) AS [target_utl],
              ISNULL(m.[target_yield], 0) AS [target_yield],
              ISNULL(m.[target_special], 0) AS [target_special],
	            ISNULL(m.[ring_factor], 0) AS [ring_factor]
          FROM LatestProduction p
          LEFT JOIN LatestAlarm a 
              ON p.[mc_no] = a.[mc_no]
              AND a.rn = 1
          LEFT JOIN MasterTarget m
            ON p.[mc_no] = m.[mc_no] COLLATE Thai_CI_AS
            AND m.rn = 1
          WHERE p.rn = 1
          ORDER BY p.[mc_no];
      `
    );
    // console.log(result[0])

    // dbms.query จะคืนค่าเป็น [results, metadata]
    return result[0];
  } catch (error) {
    console.error("Database Query Error in machineMasterQuery: ", error);
    return []; // คืนค่าเป็น Array ว่างหากเกิด Error
  }
};

// Response จากฟังก์ชันนี้จะเป็น Array ของ object เช่น:
// [{ ...ProductionColumns, alarm, occurred, part_no, target_ct, target_utl, target_yield, target_special, ring_factor }]
// Export ฟังก์ชันนี้ออกไปเพื่อให้ไฟล์อื่นเรียกใช้ได้
module.exports = master_mc_no_status;
