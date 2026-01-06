const express = require('express');
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");

const queryMbrf = async () => {
    const mbrf = await dbms.query(`
        SELECT registered
        , [mc_no]
        , a_meas as total_gauge
        , a_ng_pos as or_ng_pos
        , a_ng_neg as or_ng_neg
        , b_ng_pos as ir_ng_pos
        , b_ng_neg as ir_ng_neg
        , a_unm as or_unmatch
        , b_unm as ir_unmatch
        , [match] as match_ok
        FROM [nat_mc_assy_mbr_f].[dbo].DATA_PRODUCTION_MBR_F
        where registered between '2025-12-01' and GETDATE() and 
        DATEPART(HOUR, registered) IN (6,18)
        order by registered
    `)
    return mbrf[0].map((item) => {
        return{
            mc_no: item.mc_no.replace("_f", "").toUpperCase(),
            registered: item.registered,
            total_gauge: item.total_gauge,
            or_ng_pos: item.or_ng_pos,
            or_ng_neg: item.or_ng_neg,
            ir_ng_pos: item.ir_ng_pos,
            ir_ng_neg: item.ir_ng_neg,
            or_unmatch: item.or_unmatch,
            ir_unmatch: item.ir_unmatch,
            match_ok: item.match_ok,
        }
    })
}

const queryMbr = async () => {
    const mbr = await dbms.query(`
        SELECT registered
        , [mc_no]
        , (c1_ng+ c2_ng+ c3_ng+ c4_ng+ c5_ng) as pallet_ng
        , daily_ng as retainer_ok
        , (ball_q+sep_ng_2) as turn_table_ng
        , d2_ng as retainer_ng
        FROM [nat_mc_assy_mbr].[dbo].DATA_PRODUCTION_MBR
        where registered between '2025-12-01' and GETDATE()
        and DATEPART(HOUR, registered) IN (6,18)
        order by registered
    `)
    return mbr[0].map((item) => {
        return{
            mc_no: item.mc_no.toUpperCase(),
            registered: item.registered,
            pallet_ng: item.pallet_ng,
            retainer_ok: item.retainer_ok,
            turn_table_ng: item.turn_table_ng,
            retainer_ng: item.retainer_ng,
        }
    })
}

const queryArp = async () => {
    const arp = await dbms.query(`
        SELECT TOP (1000) [registered]
        ,[mc_no]
        ,[daily_ok]
        ,[ng_pos]
        ,[ng_neg]
        FROM [nat_mc_assy_arp].[dbo].[DATA_PRODUCTION_ARP]
        where registered between '2025-12-01' and GETDATE() and
        DATEPART(HOUR, registered) IN (6,18)
        order by registered
    `)
    return arp[0].map((item) => {
        return{
            mc_no: item.mc_no.toUpperCase(),
            registered: item.registered,
            daily_ok: item.daily_ok,
            ng_pos: item.ng_pos,
            ng_neg: item.ng_neg
        }
    })
}

router.get ('/data', async (req, res) => {
    try{
        const mbrf = await queryMbrf();
        const mbr = await queryMbr();
        const arp = await queryArp();

        const getHourKey = (item) => {
            const d = new Date(item.registered);
            const date = d.toISOString().slice(0, 10); // YYYY-MM-DD
            const hour = d.getUTCHours();              // 0–23
            return `${item.mc_no}_${date}_${hour}`;
        };
        const getDateKey = (item) => {
            const d = new Date(item.registered);
            const hour = d.getUTCHours();
            return `${item.mc_no}_${hour}`;
        };

        // const 
        const dateGrouped = arp.reduce((acc, item) => {
        const key = getDateKey(item);
        if (!acc[key]) {
            acc[key] = [];
        }
        // acc[key].push(item);
        acc[key].push({
            ...item,
            shift: key.endsWith("_18") ? "M" : "N",
            date: item.registered.toISOString().slice(0, 10).split("-")[2]}
        );
        return acc;
        }, {});

        res.json({ success: true, data: [ dateGrouped ] });
    }
    catch (error){
        console.error("Error fetching MBR-F data:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }})

module.exports = router;  