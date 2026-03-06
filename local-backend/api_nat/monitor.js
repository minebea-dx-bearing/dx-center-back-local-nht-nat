const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");
const { default: axios } = require("axios");

const port = (selectedProcess) => {
    switch (selectedProcess){
        case "mbr":
        case "tn":
            return 8086;
        case "arp":
        case "1gd":
            return 8087;
        case "gssm":
        case "2gd":
            return 8088;
        case "fim":
            return 8089;
        case "ant_new":
            return 8090;
        case "aod":
            return 8091;
        case "avs":
            return 8092;
        case "alu":
            return 8093;
        case "osp":
            return 8094;
        case "mbr_f":
            return 8095;
    }
}

const queryData = (mcList, process, results, ip, sort) => Promise.all(
    mcList.map((mc) => {
        const topicStatus = `status/nat/${process === "ant_new" ? process.split("_",1)[0] : process}/${mc.mc_no.toLowerCase()}`;
        const topicMqtt = `mqtt/nat/${process === "ant_new" ? process.split("_",1)[0] : process}/${mc.mc_no.toLowerCase()}`;
        // console.log(topicStatus, topicMqtt)
        
        return new Promise(async (resolve) => {
            try {
                const [statusRes, mqttRes] = await Promise.all([
                axios.get(`http://10.128.16.${ip}:${port(process)}/query?pretty=true&db=influx&q=SELECT "status", "topic" FROM mqtt_consumer WHERE "topic" = '${topicStatus}' ORDER BY time DESC LIMIT 1`),
                axios.get(`http://10.128.16.${ip}:${port(process)}/query?pretty=true&db=influx&q=SELECT "broker", "modbus", "topic" FROM mqtt_consumer WHERE topic = '${topicMqtt}' ORDER BY time DESC LIMIT 10`)
                ]);

                // ------- ตรวจสอบ status -------
                const statusSeries = statusRes.data?.results?.[0]?.series?.[0];
                let status = "-";
                if (statusSeries) {
                    const statusIndex = statusSeries.columns.indexOf("status");
                    status = statusSeries.values?.[0]?.[statusIndex] || "-";
                }

                // ------- ตรวจสอบ mqtt -------
                const mqttSeries = mqttRes.data?.results?.[0]?.series?.[0];
                const dataMqtt = mqttSeries?.values || [];

                let statusMqtt = {
                    broker: "no_signal",
                    modbus: "no_signal"
                };

                if (dataMqtt.length > 0) {
                const brokerIndex = mqttSeries.columns.indexOf("broker");
                const modbusIndex = mqttSeries.columns.indexOf("modbus");
                const timeIndex = mqttSeries.columns.indexOf("time");

                // เอา time ล่าสุด
                const rawTimeUTC = dataMqtt[0][timeIndex];
                const timeInThailand = new Date(rawTimeUTC);
                timeInThailand.setHours(timeInThailand.getHours() + 7); // เพิ่ม 7 ชั่วโมง

                const formattedTime = timeInThailand.toISOString().replace("T", " ").substring(0, 19);
                statusMqtt.time = formattedTime; // เพิ่ม time เข้าไปใน object

                const brokers = dataMqtt.map(row => row[brokerIndex]);
                const modbuses = dataMqtt.map(row => row[modbusIndex]);

                // ตรวจสอบเวลาล่าสุด กับเวลาปัจจุบัน
                const now = new Date();
                const nowThailand = new Date(now.getTime() + 7 * 60 * 60 * 1000);
                const diffMinutes = Math.floor((nowThailand - timeInThailand) / 1000 / 60);

                if (diffMinutes > 30) {
                    statusMqtt.broker = "lost";
                    statusMqtt.modbus = "lost";
                } else {
                    // ตรวจสอบ broker
                    if (brokers.includes(1) || brokers.includes("1")) {
                    statusMqtt.broker = "on";
                    } else if (brokers.every(val => val == 0)) {
                    statusMqtt.broker = "off";
                    }

                    // ตรวจสอบ modbus
                    if (modbuses.includes(1) || modbuses.includes("1")) {
                    statusMqtt.modbus = "on";
                    } else if (modbuses.every(val => val == 0)) {
                    statusMqtt.modbus = "off";
                    }
                }
                }

                // บันทึกค่าลงใน results โดยใช้ mc_no เป็น key
                results[mc.mc_no.toUpperCase()] = {
                mc_no: mc.mc_no.toUpperCase(),
                time_mqtt: statusMqtt.time,
                status,
                iot_broker: statusMqtt.broker,
                iot_modbus: statusMqtt.modbus,
                count: sort
                };

            } catch (err) {
                console.error(`Error for ${mc.mc_no}:`, err.message);

                results[mc.mc_no.toUpperCase()] = {
                mc_no: mc.mc_no.toUpperCase(),
                time_mqtt: "-",
                status: "error",
                iot_broker: "-",
                iot_modbus: "-",
                };
            }
            resolve();
        });
    })
);

router.post("/get_status_mqtt", async (req, res) => {
  try {
    const {selectedProcess} = req.body;
    let ip = 111;
    let get_mc = {}
    const assy = ["mbr", "mbr_f", "arp", "gssm", "fim", "ant_new", "aod", "avs"]
    let resultArray = []
    let results = {};
    let sort = 0
    if(selectedProcess === 'assy'){
        for(let process=0; process<assy.length; process++){
            get_mc = await dbms.query(`
                SELECT DISTINCT(mc_no) as mc_no
                FROM [nat_mc_assy_${assy[process]}].[dbo].[DATA_PRODUCTION_${assy[process] === "ant_new" ? assy[process].split("_",1)[0].toUpperCase() : assy[process].toUpperCase()}]
                ORDER BY mc_no ASC`)
            const mcList = get_mc[0];
            sort += 1
            await queryData(mcList, assy[process], results, ip, sort)
        }
    }
    else{
        ip = 110
        get_mc = await dbms.query(`
            SELECT DISTINCT(mc_no) as mc_no
            FROM [nat_mc_mcshop_${selectedProcess}].[dbo].[DATA_PRODUCTION_${selectedProcess.toUpperCase()}]
            WHERE mc_no != 'tb16'
            ORDER BY mc_no ASC`)
        const mcList = get_mc[0];
        await queryData(mcList, selectedProcess, results, ip, sort)
    }
    resultArray.push(...Object.values(results))

    return res.json({ data: resultArray, success: true, });
  } catch (error) {
    console.error("get_time_status error:", error.message);
    return res.status(500).json({ data: error.message, success: false });
  }
})

module.exports = router;