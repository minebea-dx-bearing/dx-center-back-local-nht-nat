const express = require("express");
const router = express.Router();
const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");

router.get("/getData/:startQuery/:endQuery", async (req, res) => {
    let { startQuery, endQuery } = req.params;
    const endWorkDay = moment(endQuery).add(1, "days").format("YYYY-MM-DD");
    try {
        const response = await dbms.query(`
            WITH [data] as (
                SELECT 
                    [registered]
                    ,CASE WHEN DATEPART(HOUR, registered) <= 6 THEN CONVERT(date, DATEADD(DAY, -1, registered))
                        ELSE CONVERT(date, registered)
                    END AS [work_date]
                    ,[mc_no]
                    ,LEFT(mc_no, 2) AS mc_type
                    ,[process]
                    ,[avgct]
                    ,[utilization]
                FROM [nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD]
                WHERE registered >= '${startQuery} 07:00' and registered <= '${endWorkDay} 07:00'
            ),
            [calc_ct] AS (
                SELECT work_date, ROUND(AVG([avgct])/100, 2) AS [avgct], LEFT(mc_no, 4) AS mc_no, MAX(mc_type) AS mc_type
                FROM [data]
                WHERE [avgct]>=200 AND [avgct]<=400
                GROUP BY work_date, mc_no
            ),
            [max_ct] AS (
                SELECT
                    work_date,
                    mc_no,
                    MAX(mc_type) AS mc_type,
                    MAX([avgct]) AS [avgct]
                FROM [calc_ct]
                GROUP BY work_date, mc_no
            ),
            [calc_utl] AS (
                SELECT work_date, ROUND(AVG([utilization])/10, 2) AS [avgutl], LEFT(mc_no, 4) AS mc_no
                FROM [data]
                WHERE mc_no LIKE '%h'
                GROUP BY work_date, mc_no
            )
            SELECT ct.*, utl.[avgutl]
            FROM [max_ct] ct
            LEFT JOIN [calc_utl] utl ON ct.mc_no = utl.mc_no AND ct.work_date = utl.work_date
            ORDER BY mc_no, work_date
        `);

        if (response[1] > 0) {
            let data = response[0];

            const groupedData = data.reduce((acc, item) => {
                const key = `${item.work_date}_${item.mc_type}`;

                // 2. ถ้ายังไม่เคยมี Key นี้ใน Object ผลลัพธ์ (acc) ให้สร้างโครงสร้างเริ่มต้นไว้ก่อน
                if (!acc[key]) {
                    acc[key] = {
                        work_date: item.work_date,
                        mc_type: item.mc_type,
                        ct: [],
                        utl: []
                    };
                }

                acc[key].ct.push(item.avgct);
                acc[key].utl.push(item.avgutl);

                return acc;
            }, {});

            Object.keys(groupedData).forEach((key) => {
                const ctArray = groupedData[key].ct;
                const utlArray = groupedData[key].utl;
                
                const sumCt = ctArray.reduce((sum, currentCt) => sum + currentCt, 0);
                const sumUtl = utlArray.reduce((sum, currentUtl) => sum + currentUtl, 0);
                
                const avgCt = Number((sumCt / ctArray.length).toFixed(2));
                const avgUtl = Number((sumUtl / utlArray.length).toFixed(2));

                // 3. ยัดฟิลด์ avg ใหม่เข้าไปในบ้านหลังเดิม
                groupedData[key].avgCt = avgCt;
                groupedData[key].avgUtl = avgUtl;
            });

            // const calcAvg = (arr) => arr.length === 0 ? 0 : Number(arr.reduce((acc, val) => acc + val, 0) / arr.length).toFixed(2);
            const finalArray = Object.keys(groupedData).map((key) => {
                return {
                    ...groupedData[key] // เทข้อมูล date, age, avg ตามลงไป
                };
            });

            res.json({
                success: true,
                data,
                avgData: finalArray
            });
        } else {
            res.json({
                success: false,
                message: "can't get data in database",
            });
        }
    } catch (error) {
        console.error(error);
        res.json({
            success: false,
            message: "Can't get data select from database",
            error: error.message,
        });
    }
});

module.exports = router;