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
                    ,[process]
                    ,[avgct]
                    ,[yieldrt]
                    ,[ng_p]
                    ,[ng_n]
                    ,[tng]
                    ,[prod_total]
                    ,[utilization]
                    ,[ng_plug]
                FROM [nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD]
                WHERE registered >= '${startQuery} 07:00' and registered <= '${endWorkDay} 07:00'
            )
            SELECT work_date, mc_no, ROUND(AVG([avgct])/100, 2) AS [avgct], ROUND(AVG([utilization])/10, 2) AS [utilization]
            FROM [data]
            GROUP BY work_date, mc_no
            ORDER BY mc_no, work_date
        `);

        if (response[1] > 0) {
            let data = response[0];
            res.json({
                success: true,
                data,
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