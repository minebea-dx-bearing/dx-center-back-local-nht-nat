const express = require("express");
const router = express.Router();
const moment = require("moment");
const dbms = require("../instance/ms_instance_nat");

const queryRawData = async (startDateQuery, endDateQuery) => {
    const data = await dbms.query(`
        with [mic] AS(
            SELECT
                prod.[registered]
                ,CASE WHEN DATEPART(HOUR, prod.registered) <= 6 THEN CONVERT(date, DATEADD(DAY, -1, prod.registered))
                    ELSE CONVERT(date, prod.registered)
                END AS [work_date]
                ,UPPER(prod.[mc_no]) AS [mc_no]
                ,[part_no]
                ,[daily_ok]
                ,[ball_q] AS [ball_short_ng]
                ,[sep_ng_2] AS [ball_sepa_ng]
                ,[d2_ng] AS [rtnr_ng]
            FROM  [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR] prod
			LEFT JOIN [nat_mc_assy_mbr].[dbo].[DATA_MASTER_MBR] part
            ON prod.[mc_no] = part.[mc_no]
        ),
        [calSepa] AS (
            SELECT
                [registered]
                ,[work_date]
                ,[mc_no]
                ,[part_no]
                ,CASE WHEN [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [daily_ok]
                    ELSE [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [daily_ok]
                ,CASE WHEN [ball_short_ng] - LAG([ball_short_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [ball_short_ng]
                    ELSE [ball_short_ng] - LAG([ball_short_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [ball_short_ng]
                ,CASE WHEN [ball_sepa_ng] - LAG([ball_sepa_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [ball_sepa_ng]
                    ELSE [ball_sepa_ng] - LAG([ball_sepa_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [ball_sepa_ng]
                ,CASE WHEN [rtnr_ng] - LAG([rtnr_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [rtnr_ng]
                    ELSE [rtnr_ng] - LAG([rtnr_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [rtnr_ng]
            FROM [mic]
            WHERE [work_date] BETWEEN DATEADD(DAY,-1,'${startDateQuery}') AND '${endDateQuery}'
        ),
        [cal_total_prod] AS (
            SELECT *
                ,[daily_ok] + [ball_short_ng] + [ball_sepa_ng] + [rtnr_ng] as [total_prod]
            FROM [calSepa]
        )
        SELECT [work_date]
            ,[mc_no]
            ,[part_no]
            ,SUM([total_prod]) AS [total_prod]
            ,SUM([daily_ok]) AS [daily_ok]
            ,SUM([ball_short_ng]) AS [ball_short_ng]
            ,SUM([ball_sepa_ng]) AS [ball_sepa_ng]
            ,SUM([rtnr_ng]) AS [rtnr_ng]
            ,SUM([ball_short_ng]) + SUM([ball_sepa_ng]) + SUM([rtnr_ng]) AS [sumNG]
			,MAX([size]) AS [ball_no]
			,MAX([ball_mat]) AS [ball_mat]
			,MAX([ball_qty]) AS [ball_qty]
        FROM [cal_total_prod] prod
		LEFT JOIN [nat_mc_assy_mbr].[dbo].[MASTER_BALL] ball
		ON prod.[part_no] LIKE '%' + ball.[series] + '%'
        where [work_date] >= '${startDateQuery}' AND ([total_prod] + [ball_short_ng] + [ball_sepa_ng] + [rtnr_ng] + [daily_ok] != 0)
        GROUP BY [work_date]
            ,[mc_no]
            ,[part_no]
        ORDER BY [work_date] DESC, [mc_no]
    `);

    return data[0]
}

const queryRawTop3DataTable = async (startDateQuery, endDateQuery, mcCondition, partCondition) => {
    const data = await dbms.query(`
        with [mic] AS(
            SELECT
                prod.[registered]
                ,CASE WHEN DATEPART(HOUR, prod.registered) <= 6 THEN CONVERT(date, DATEADD(DAY, -1, prod.registered))
                    ELSE CONVERT(date, prod.registered)
                END AS [work_date]
                ,UPPER(prod.[mc_no]) AS [mc_no]
                ,[part_no]
                ,[daily_ok]
                ,[ball_q] AS [ball_short_ng]
                ,[sep_ng_2] AS [ball_sepa_ng]
                ,[d2_ng] AS [rtnr_ng]
            FROM [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR] prod
			LEFT JOIN [nat_mc_assy_mbr].[dbo].[DATA_MASTER_MBR] part
            ON prod.[mc_no] = part.[mc_no]
        ),
        [calSepa] AS (
            SELECT
                [registered]
                ,[work_date]
                ,[mc_no]
                ,[part_no]
                ,CASE WHEN [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [daily_ok]
                    ELSE [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [daily_ok]
                ,CASE WHEN [rtnr_ng] - LAG([rtnr_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [rtnr_ng]
                    ELSE [rtnr_ng] - LAG([rtnr_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [rtnr_ng]
                ,CASE WHEN [ball_sepa_ng] - LAG([ball_sepa_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [ball_sepa_ng]
                    ELSE [ball_sepa_ng] - LAG([ball_sepa_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [ball_sepa_ng]
                ,CASE WHEN [ball_short_ng] - LAG([ball_short_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [ball_short_ng]
                    ELSE [ball_short_ng] - LAG([ball_short_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [ball_short_ng]
            FROM [mic]
			WHERE [work_date] BETWEEN DATEADD(DAY,-1,'${startDateQuery}') AND '${endDateQuery}' ${mcCondition} ${partCondition}
        ),
        [cal_total_prod] AS (
            SELECT *
                ,[daily_ok] + [ball_short_ng] + [ball_sepa_ng] + [rtnr_ng] as [total_prod]
            FROM [calSepa]
        )
		SELECT 
			mc_no,
			STRING_AGG(part_no, ', ') WITHIN GROUP (ORDER BY part_no) AS part_no,
			SUM([ball_short_ng] + [ball_sepa_ng] + [rtnr_ng] + [daily_ok]) AS total_prod,
			SUM([ball_short_ng]) AS [ball_short_ng],
			SUM([ball_sepa_ng]) AS [ball_sepa_ng],
			SUM([rtnr_ng]) AS [rtnr_ng],
			SUM([daily_ok]) AS [daily_ok]
		FROM (
			SELECT mc_no, 
				part_no, 
				SUM([ball_short_ng]) as [ball_short_ng], 
				SUM([ball_sepa_ng]) as [ball_sepa_ng], 
				SUM([rtnr_ng]) as [rtnr_ng], 
				SUM([daily_ok]) as [daily_ok]
			FROM [cal_total_prod]
			where [work_date] >= '${startDateQuery}' AND ([total_prod] + [ball_short_ng] + [ball_sepa_ng] + [rtnr_ng] + [daily_ok] != 0)
			GROUP BY mc_no, part_no
		) AS GroupedByPart
		GROUP BY mc_no
		ORDER BY mc_no;
    `);

    return data[0]
}

const queryRawDataDaily = async (startDateQuery, endDateQuery, mcCondition, partCondition) => {
    const data = await dbms.query(`
        with [mic] as(
            SELECT
                prod.[registered]
                ,CASE WHEN DATEPART(HOUR, prod.registered) <= 6 THEN CONVERT(date, DATEADD(DAY, -1, prod.registered))
                    ELSE CONVERT(date, prod.registered)
                END AS [work_date]
                ,UPPER(prod.[mc_no]) AS [mc_no]
                ,[part_no]
                ,[daily_ok]
                ,[ball_q] AS [ball_short_ng]
                ,[sep_ng_2] AS [ball_sepa_ng]
                ,[d2_ng] AS [rtnr_ng]
            FROM [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR] prod
			LEFT JOIN [nat_mc_assy_mbr].[dbo].[DATA_MASTER_MBR] part
            ON prod.[mc_no] = part.[mc_no]
        ),
        [calSepa] AS (
            SELECT
                [registered]
                ,[work_date]
                ,[mc_no]
                ,CASE WHEN [rtnr_ng] - LAG([rtnr_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [rtnr_ng]
                    ELSE [rtnr_ng] - LAG([rtnr_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [rtnr_ng]
                ,CASE WHEN [ball_sepa_ng] - LAG([ball_sepa_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [ball_sepa_ng]
                    ELSE [ball_sepa_ng] - LAG([ball_sepa_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [ball_sepa_ng]
                ,CASE WHEN [ball_short_ng] - LAG([ball_short_ng]) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN [ball_short_ng]
                    ELSE [ball_short_ng] - LAG([ball_short_ng]) OVER (PARTITION BY mc_no ORDER BY registered)
                END AS [ball_short_ng]
            FROM [mic]
			WHERE [work_date] BETWEEN DATEADD(DAY,-1,'${startDateQuery}') AND '${endDateQuery}' ${mcCondition} ${partCondition}
        )
        SELECT [work_date]
            ,SUM([ball_short_ng]) AS [ball_short_ng]
            ,SUM([ball_sepa_ng]) AS [ball_sepa_ng]
            ,SUM([rtnr_ng]) AS [rtnr_ng]
            ,SUM([ball_short_ng]) + SUM([ball_sepa_ng]) + SUM([rtnr_ng]) AS [sumNG]
        FROM [calSepa]
        where [work_date] >= '${startDateQuery}'
        GROUP BY [work_date]
        order by [work_date]
    `);
    return data[0]
}


router.post("/selectMic_item", async (req, res) => {
    try {
        let { startDateQuery, endDateQuery } = req.body;
        // console.log(startDateQuery, endDateQuery)

        let resultSelect = await dbms.query(
            `
                SELECT DISTINCT
                    UPPER(prod.[mc_no]) AS [mc_no]
                    ,[part_no]
                FROM [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR] prod
				LEFT JOIN [nat_mc_assy_mbr].[dbo].[DATA_MASTER_MBR] part
				ON prod.mc_no = part.mc_no
                WHERE prod.[registered] BETWEEN '${startDateQuery} 07:00' AND DATEADD(DAY, 1, '${endDateQuery} 07:00')
            `
        );
        res.json({
            success: true,
            resultSelect,
        });
    } catch (error) {
        console.error(error);
        res.json({
            success: false,
            message: "Can't get data select from database",
            error: error.message,
        });
    }
});

router.post("/getMicData", async (req, res) => {
    try{
        let { startDateQuery, endDateQuery, machine_no = "ALL", part = "ALL" } = req.body;
        console.log(startDateQuery, endDateQuery)
        if (machine_no.length === 0) {
            machine_no = "ALL";
        }
        if (part.length === 0) {
            part = "ALL";
        }

        // count all machine
        let totalMc = await dbms.query(
            `
                with [type] as (
                    SELECT DISTINCT
						[process],
                        [mc_no]
                    FROM [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR]
                )
                SELECT COUNT([mc_no]) AS [mc_count]
                FROM type
                GROUP BY [process]
            `
        );
        let countTotal = totalMc[0][0].mc_count

        // data     
        let data = await queryRawData(startDateQuery, endDateQuery);

        let rawData = data.map((item) => {
            const yield_ok = Number.isNaN((item.daily_ok/item.total_prod)*100) ? "" : Number((item.daily_ok/item.total_prod)*100).toFixed(2)
            return { ...item, 
                    yield_ok: yield_ok};
        });
        // console.log(rawData)

        // filter
        if (!machine_no.includes("ALL")) {
            rawData = rawData.filter((item) => machine_no.includes(item.mc_no));
        }
        if (!part.includes("ALL")) {
            rawData = rawData.filter((item) => part.includes(item.part_no));
        }

        let totalResult = {
            // total
            total: 0,
            totalOk: 0,
            totalNg: 0,
            percentOk: 0,
            countTotal: countTotal,
            totalCount: [...new Set(rawData.map((item) => item.mc_no))].length,
            // NG
            totalBallShort: 0,
            totalBallSepa: 0,
            totalRtnrNG: 0
        };
    
        rawData.forEach((item) => {
            totalResult.total += item.total_prod;
            totalResult.totalOk += item.daily_ok;
            totalResult.totalNg += item.sumNG
            totalResult.totalBallShort += item.ball_short_ng;
            totalResult.totalBallSepa += item.ball_sepa_ng;
            totalResult.totalRtnrNG += item.rtnr_ng;
        });

        const percentOk = ((totalResult?.totalOk/totalResult?.total)*100);

        totalResult.percentOk = Number.isNaN(percentOk) ? 0 : Number(percentOk).toFixed(2)

        // for chart
        const percentBallShort = ((totalResult?.totalBallShort/totalResult?.totalNg)*100);
        const percentBallSepa = ((totalResult?.totalBallSepa/totalResult?.totalNg)*100);
        const percentRtnrNG = ((totalResult?.totalRtnrNG/totalResult?.totalNg)*100);

        let chartNg = [{
            name: "Ball Short",
            value: Number.isNaN(percentBallShort) ? 0 : Number(percentBallShort).toFixed(2),
            prod: totalResult.totalBallShort
        },
        {
            name: "Ball Separate",
            value: Number.isNaN(percentBallSepa) ? 0 : Number(percentBallSepa).toFixed(2),
            prod: totalResult.totalBallSepa
        },
        {
            name: "Retainer NG",
            value: Number.isNaN(percentRtnrNG) ? 0 : Number(percentRtnrNG).toFixed(2),
            prod: totalResult.totalRtnrNG
        }];

        res.json({
            success: true,
            rawData,
            totalResult,
            chartNg
        });
    }catch (error) {
        console.error(error);
        res.json({
            success: false,
            message: "Can't get data from database",
            error: error.message,
        });
    }
})

router.post("/getTop3MicData", async (req, res) => {
    try{
        let { startDateQuery, endDateQuery, machine_no = "ALL", part = "ALL" } = req.body;
        let mcCondition = "";
        let partCondition = "";

        if (machine_no && machine_no.length > 0) {
            const formattedIn = machine_no.map(item => `'${item}'`).join(',');
            mcCondition = `AND mc_no IN (${formattedIn})`;
        } 

        if (part && part.length > 0) {
            const formattedIn = part.map(item => `'${item}'`).join(',');
            partCondition = `AND part_no IN (${formattedIn})`;
        }

        console.log()

        let dataTop3 = await queryRawTop3DataTable(startDateQuery, endDateQuery, mcCondition, partCondition)

        let rawTop3DataTable = dataTop3.map((item) => {
            const yield_ok = Number.isNaN((item.daily_ok/item.total_prod)*100) ? "" : Number((item.daily_ok/item.total_prod)*100).toFixed(2)
            return {
                ...item,
                yield_ok: yield_ok
            };
        });
        
        rawTop3DataTable = rawTop3DataTable.sort((a, b) => a.yield_ok - b.yield_ok).slice(0, 3);
        let mc_no = []
        
        rawTop3DataTable.forEach((item) => {
            mc_no.push(`'${item.mc_no}'`)
            item.percentBallShort =  Number((item?.ball_short_ng/item?.total_prod)*100).toFixed(2);
            item.percentBallSepa =  Number((item?.ball_sepa_ng/item?.total_prod)*100).toFixed(2);
            item.percentRtnrNG =  Number((item?.rtnr_ng/item?.total_prod)*100).toFixed(2);
        })

        mcCondition = `AND mc_no IN (${mc_no})`;

        let dataTop3Daily = await queryRawDataDaily(startDateQuery, endDateQuery, mcCondition, partCondition)

        let date = []
        let ballShort = []
        let ballSepa = []
        let rtnrNg = []
        let total = []

        dataTop3Daily.map((item) => {
            date.push(item.work_date)
            ballShort.push(item.ball_short_ng)
            ballSepa.push(item.ball_sepa_ng)
            rtnrNg.push(item.rtnr_ng)
            total.push(item.sumNG)
        })

        let dataTop3DailyChart = {
            date: date,
            ballShort: ballShort,
            ballSepa: ballSepa,
            rtnrNg: rtnrNg,
            total: total
        }

        res.json({
            success: true,
            rawTop3DataTable,
            dataTop3DailyChart
        });
    }catch (error) {
        console.error(error);
        res.json({
            success: false,
            message: "Can't get top 3 data from database",
            error: error.message,
        });
    }
})

router.post("/getByDateMicData", async (req, res) => {
    try{
        let { startDateQuery, endDateQuery, machine_no = "ALL", part = "ALL" } = req.body;

        let mcCondition = "";
        let partCondition = "";

        if (machine_no && machine_no.length > 0) {
            const formattedIn = machine_no.map(item => `'${item}'`).join(',');
            mcCondition = `AND mc_no IN (${formattedIn})`;
        } 

        if (part && part.length > 0) {
            const formattedIn = part.map(item => `'${item}'`).join(',');
            partCondition = `AND part_no IN (${formattedIn})`;
        }

        let rawDataByDate = await queryRawDataDaily(startDateQuery, endDateQuery, mcCondition, partCondition);
        
        let date = []
        let ballShort = []
        let ballSepa = []
        let rtnrNg = []
        let total = []

        rawDataByDate.map((item) => {
            date.push(item.work_date)
            ballShort.push(item.ball_short_ng)
            ballSepa.push(item.ball_sepa_ng)
            rtnrNg.push(item.rtnr_ng)
            total.push(item.ball_short_ng + item.ball_sepa_ng + item.rtnr_ng)
        })

        let dataByDateChart = {
            date: date,
            ballShort: ballShort,
            ballSepa: ballSepa,
            rtnrNg: rtnrNg,
            total: total
        }

        res.json({
            success: true,
            dataByDateChart
        });
    }catch (error) {
        console.error(error);
        res.json({
            success: false,
            message: "Can't get top 3 data from database",
            error: error.message,
        });
    }
})

module.exports = router;