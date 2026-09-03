/**
 * ฟังก์ชันสำหรับ Query ข้อมูล Master ของเครื่องจักรล่าสุด
 * @param {object} dbms - Sequelize instance สำหรับการเชื่อมต่อฐานข้อมูล
 * @param {string} DATABASE_PROD - ชื่อตาราง Production
 * @param {string} DATABASE_ALARM - ชื่อตาราง Alarm
 * @returns {Promise<Array>} - Array ของข้อมูลเครื่องจักร
 */
const master_mc_no = async (dbms, DATABASE_PROD, DATABASE_STATUS, DATABASE_MASTER) => {
  try {
    const result = await dbms.query(
      `
        WITH LatestProduction AS (
            SELECT
                *
                ,ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) AS rn
            FROM ${DATABASE_PROD}
            WHERE [registered] >= DATEADD(day, -3, GETDATE())
        ),
        Lateststatus AS (
            SELECT
                [mc_no],
                [mc_status],
                [occurred],
                CASE
                    WHEN UPPER([mc_status]) LIKE '%REAR%' THEN 'REAR'
                    WHEN UPPER([mc_status]) LIKE '%FRONT%' THEN 'FRONT'
                END AS status_type,
                ROW_NUMBER() OVER ( PARTITION BY [mc_no],
                    CASE
                        WHEN UPPER([mc_status]) LIKE '%REAR%' THEN 'REAR'
                        WHEN UPPER([mc_status]) LIKE '%FRONT%' THEN 'FRONT'
                    END
					ORDER BY [occurred] DESC
                ) AS rn
            FROM ${DATABASE_STATUS}
            WHERE
                UPPER([mc_status]) LIKE '%RUN%'
                AND [occurred] >= DATEADD(day, -3, GETDATE())
        ),
        Pivotedstatuss AS (
            SELECT
                [mc_no],
                MAX(CASE WHEN status_type = 'FRONT' THEN [mc_status] END) AS status_front,
                MAX(CASE WHEN status_type = 'FRONT' THEN [occurred] END) AS occurred_front,
                MAX(CASE WHEN status_type = 'REAR' THEN [mc_status] END) AS status_rear,
                MAX(CASE WHEN status_type = 'REAR' THEN [occurred] END) AS occurred_rear
            FROM Lateststatus
            WHERE rn = 1  -- เอาเฉพาะ status ล่าสุดของแต่ละประเภท
            GROUP BY [mc_no] -- รวมข้อมูลให้เหลือ mc_no ละ 1 แถว
        )
        SELECT 
            p.*, -- เลือกทุกคอลัมน์จาก Production
            ISNULL(a.status_front, 'no data run') AS status_front,
            a.occurred_front,
            ISNULL(a.status_rear, 'no data run') AS status_rear,
            a.occurred_rear
        FROM LatestProduction p
        LEFT JOIN Pivotedstatuss a ON p.[mc_no] = a.[mc_no] COLLATE Thai_CI_AS
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
