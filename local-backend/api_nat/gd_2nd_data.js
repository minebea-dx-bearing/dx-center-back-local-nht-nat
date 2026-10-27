const express = require("express");
const router = express.Router();
const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");

router.get("/getData/:startQuery/:endQuery", async (req, res) => {
    let { startQuery, endQuery } = req.params;
    const endWorkDay = moment(endQuery).add(1, "days").format("YYYY-MM-DD");
    try {
        const response = await dbms.query(`
            SELECT 
                [registered]
                ,CASE WHEN DATEPART(HOUR, registered) <= 6 THEN CONVERT(date, DATEADD(DAY, -1, registered))
                    ELSE CONVERT(date, registered)
                END AS [work_date]
                ,[mc_no]
                ,LEFT(mc_no, 2) AS mc_type
                ,[process]
                ,[avgct]/100 AS [avgct]
                ,[utilization]/10 AS [utilization]
            FROM [nat_mc_mcshop_2gd].[dbo].[DATA_PRODUCTION_2GD]
            WHERE registered >= '${startQuery} 07:00' and registered <= '${endWorkDay} 07:00' AND mc_no LIKE '%h'
        `);

        if (response[1] > 0) {
            let data = response[0];

            // ฟังก์ชันกลางสำหรับหาค่าเฉลี่ย (มี guard กันกรณี array ว่างหารด้วย 0)
            const calcAvg = (arr) => arr.length ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2)) : 0;

            // ขั้นตอนที่ 1: Group by work_date + mc_no และคำนวณ Trimmed Avg CT กับ Avg UTL
            const mcMap = data.reduce((acc, { work_date, mc_type, mc_no, avgct, utilization }) => {
                const key = `${work_date}_${mc_no}`;
                if (!acc[key]) acc[key] = { work_date, mc_type, mc_no, ct: [], utl: [] };
                acc[key].ct.push(avgct);
                acc[key].utl.push(utilization);
                return acc;
            }, {});

            const mcAggregated = Object.values(mcMap).map((item) => {
                // ตัด 2 ค่าหน้า-หลัง หลังเรียงลำดับ (Trimmed Mean) ถ้าข้อมูลน้อยกว่าหรือเท่ากับ 4 จะใช้ array เดิม
                const sortedCt = [...item.ct].sort((a, b) => a - b);
                const trimmedCt = sortedCt.length > 4 ? sortedCt.slice(2, -2) : sortedCt;

                return {
                    work_date: item.work_date,
                    mc_type: item.mc_type,
                    mc_no: item.mc_no,
                    ct: calcAvg(trimmedCt),
                    utl: calcAvg(item.utl),
                };
            });

            // ขั้นตอนที่ 2: Group by work_date + mc_type และคำนวณค่าเฉลี่ยสรุปเป็น Array สุดท้าย
            const typeMap = mcAggregated.reduce((acc, { work_date, mc_type, ct, utl }) => {
                const key = `${work_date}_${mc_type}`;
                if (!acc[key]) acc[key] = { work_date, mc_type, ct: [], utl: [] };
                acc[key].ct.push(ct);
                acc[key].utl.push(utl);
                return acc;
            }, {});

            const finalArray = Object.values(typeMap).map((item) => ({
                work_date: item.work_date,
                mc_type: item.mc_type,
                ct: calcAvg(item.ct),
                utl: calcAvg(item.utl),
            }));

            res.json({
                success: true,
                data: mcAggregated,
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