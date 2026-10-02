const express = require("express");
const router = express.Router();
const mbr = require('../assy_realtime/assy_mbr_realtime_new')
const arp = require('../assy_realtime/assy_arp_realtime_new')
const alu = require('../assy_realtime/assy_alu_realtime_new');

const rearrangeData = (rawData, headerData) => {
    const process = Object.keys(rawData);
    const totalMachines = rawData[process[0]] ? rawData[process[0]].length : 0;
    const groups = [];

    for(let line=0; line<totalMachines; line+=2){
        const oddLine = line+1;
        const evenLine = line+2;

        const groupId = evenLine <= totalMachines ? `${oddLine}&${evenLine}` : `${oddLine}`;

        const lineIndices = [line];
        if (evenLine <= totalMachines) lineIndices.push(line + 1);

        const lineData = lineIndices.map((i)=> {
            const lineNo = i+1;

            const lineHeader = {lineName: `Line ${lineNo}`, partNo: headerData[i].part_no, 
            packing: headerData[i].prod_ok_daily, packingDiff: headerData[i].prod_diff_daily}
            
            const pages = [];
            let pageIndex = 0;
            
            for(let p=0; p<process.length; p+=2){
                const process1 = process[p];
                const process2 = process[p+1];

                // เก็บข้อมูลที่ละ 2 processes ของแต่ละ line
                const data = [];
                if(rawData[process1]?.[i]) data.push(rawData[process1][i]);
                if(process2 && rawData[process2]?.[i]) data.push(rawData[process2][i]);
    
                const pageLabel = process2 ? `${process1} & ${process2}` : process1;
    
                pages.push({
                    pageIndex: pageIndex++,
                    pageLabel: pageLabel,
                    data: data
                })
            }
            return({
                lineId: `${lineNo}`,
                lineHeader,
                pages
            })
        })
        groups.push({
            groupId,
            line: lineData
        })
    }
    return groups
}

router.get("/", async (req, res) => {
    try {
        const mbrData = await mbr.machinesData();
        const arpData = await arp.machinesData();
        const aluData = await alu.machinesData();

        const header = aluData.data.map((i) => {
            return {
                line: Number(i.mc_no.match(/\d+/)[0]),
                part_no: i.part_no,
                prod_ok_daily: i.prod_ok_daily,
                prod_diff_daily: i.prod_diff_daily
            }
        })
        
        const rawData = {
            "mbr": mbrData.data,
            "arp": arpData.data
        }

        const finalData = await rearrangeData(rawData, header)

        res.json(finalData);
    } catch (error) {
        res.status(500).json({ data: [], success: false, message: "Internal Server Error" });
    }
})

module.exports = router;