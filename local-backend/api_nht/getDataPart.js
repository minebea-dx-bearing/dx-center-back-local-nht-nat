const express = require("express");
const router = express.Router();
const moment = require("moment");
const dbms = require("../instance/ms_instance_nht");

const schedule = require("node-schedule");
// Script Run Update Part_no to database Master [MBR,GSSM, FIM, AN]
schedule.scheduleJob("- * * * *", async function (req, res) {
    try {
        await GetData();
    } catch (error) {
        console.log("scheduleJob GetPart Error :", error);
        
    }
})

async function GetData() {
    try {
        const result = await dbms.query(`
            SELECT mc_no, model, mc_suffix, partno
            FROM (
                SELECT 
                    [mc_no],
                    [model],
                    RIGHT([mc_no], 4) AS mc_suffix,
                    [model] AS [partno],
                    ROW_NUMBER() OVER (PARTITION BY [mc_no] ORDER BY [registered] DESC) as rn
                FROM [data_machine_assy1].[dbo].[DATA_PRODUCTION_ASSY]
                WHERE [registered] >= DATEADD(day, -3, GETDATE())
            ) AS tmp
            WHERE rn = 1
            ORDER BY mc_no ASC
        `);
        const dataList = result[0]; 

        if (dataList.length === 0) {
            console.log("No new data to update.");
            return;
        }

        for (const item of dataList) {
            try {
                const part = item.partno;
                const mc = item.mc_suffix;
                await dbms.query(`
                    UPDATE [data_machine_gssm].[dbo].[DATA_MASTER_GSSM] 
                    SET part_no = '${part}'
                    WHERE RIGHT(mc_no, 4) = '${mc}' 
                    UPDATE [data_machine_fim].[dbo].[DATA_MASTER_FIM] 
                    SET part_no = '${part}' 
                    WHERE RIGHT(mc_no, 4) = '${mc}' 
                    UPDATE [data_machine_an2].[dbo].[DATA_MASTER_AN] 
                    SET part_no = '${part}' 
                    WHERE RIGHT(mc_no, 4) = '${mc}';
                `);
                
                console.log(`Synced MC Suffix: ${item.mc_suffix}`);
            } catch (err) {
                console.error(`Error updating MC ${item.mc_no}:`, err.message);
                console.error(`❌ Error updating MC ${item ? item.mc_no : 'Unknown'}:`, err);
            }
        }
    } catch (error) {
        console.error("Main Process Error:", error);
    }
};


module.exports = router;
