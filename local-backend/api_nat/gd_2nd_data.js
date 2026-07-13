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
            LEFT JOIN [calc_utl] utl ON ct.mc_no = utl.mc_no
            ORDER BY mc_no, work_date
        `);

        if (response[1] > 0) {
            let data = response[0];
            let avgCtIR = []
            let avgCtOR = []
            let avgUtl = []
            data.map((i) => {
                i.mc_type === "ir" ? avgCtIR.push(i.avgct) : avgCtOR.push(i.avgct)
                avgUtl.push(i.avgutl)
            })
            const calcAvg = (arr) => arr.length === 0 ? 0 : Number(arr.reduce((acc, val) => acc + val, 0) / arr.length).toFixed(2);
            
            res.json({
                success: true,
                data,
                avgCtIR: calcAvg(avgCtIR),
                avgCtOR: calcAvg(avgCtOR),
                avgUtl: calcAvg(avgUtl),
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