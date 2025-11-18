const express = require("express");
const { queryCurrentRunningTime: currentMBRF, getMachineData: machineDataMBRF, prepareRealtimeData: prepareMBRF } = require("./assy_mbrf_realtime");
const { queryCurrentRunningTime: currentMBR, getMachineData: machineDataMBR, prepareRealtimeData: prepareMBR } = require("./assy_mbr_realtime");
const { queryCurrentRunningTime: currentARP, getMachineData: machineDataARP, prepareRealtimeData: prepareARP } = require("./assy_arp_realtime");
const { queryCurrentRunningTime: currentGSSM, getMachineData: machineDataGSSM, prepareRealtimeData: prepareGSSM } = require("./assy_gssm_realtime");
const { queryCurrentRunningTime: currentFIM, getMachineData: machineDataFIM, prepareRealtimeData: prepareFIM } = require("./assy_fim_realtime");
const { queryCurrentRunningTime: currentANT, getMachineData: machineDataANT, prepareRealtimeData: prepareANT } = require("./assy_ant_realtime");
const { queryCurrentRunningTime: currentAOD, getMachineData: machineDataAOD, prepareRealtimeData: prepareAOD } = require("./assy_aod_realtime");
const { queryCurrentRunningTime: currentAVS, getMachineData: machineDataAVS, prepareRealtimeData: prepareAVS } = require("./assy_avs_realtime");
const { queryCurrentRunningTime: currentALU, getMachineData: machineDataALU, prepareRealtimeData: prepareALU } = require("./assy_alu_realtime");
const router = express.Router();

router.get("/", async (req, res) => {
  const dataMBRF = prepareMBRF(machineDataMBRF(), await currentMBRF());
  const dataMBR = prepareMBR(machineDataMBR(), await currentMBR());
  const dataARP = prepareARP(machineDataARP(), await currentARP());
  const dataGSSM = prepareGSSM(machineDataGSSM(), await currentGSSM());
  const dataFIM = prepareFIM(machineDataFIM(), await currentFIM());
  const dataANT = prepareANT(machineDataANT(), await currentANT());
  const dataAOD = prepareANT(machineDataAOD(), await currentAOD());
  const dataAVS = prepareAVS(machineDataAVS(), await currentAVS());
  const dataALU = prepareALU(machineDataALU(), await currentALU());

  const combinedData = [...dataMBRF, ...dataMBR, ...dataARP, ...dataGSSM, ...dataFIM, ...dataANT, ...dataAOD, ...dataAVS, ...dataALU].map((item) => {
    const machineNumber = parseInt(item.mc_no.slice(-2));
    const lineMaster = machineNumber === 1 ? `${item.process}-FIRST` : `${item.process}-SECOND`;
    return {
      ...item,
      lineMaster,
      line: machineNumber,
    };
  });

  const finalStructure = combinedData.reduce((acc, machine) => {
    // acc คือ object ที่เรากำลังสร้างขึ้น (accumulator)
    // machine คือ object ของเครื่องจักรในแต่ละรอบ

    // 1. คำนวณหา key ของกลุ่มหลัก (เช่น "line1&2", "line3&4")
    const groupIndex = Math.floor((machine.line - 1) / 2);
    const startLine = groupIndex * 2 + 1;
    const endLine = groupIndex * 2 + 2;
    const groupKey = `${startLine}&${endLine}`;

    // 2. ถ้ายังไม่มีกลุ่มนี้ใน object หลัก ให้สร้างขึ้นมาก่อน
    if (!acc[groupKey]) {
      acc[groupKey] = {};
    }

    // 3. นำข้อมูลเครื่องจักรไปใส่ในกลุ่มที่ถูกต้อง โดยใช้ lineMaster เป็น key
    // และตัว machine object ทั้งหมดเป็น value
    acc[groupKey][machine.lineMaster] = machine;

    // 4. return acc เพื่อใช้ในรอบถัดไป
    return acc;
  }, {}); // `{}` คือค่าเริ่มต้นของ accumulator (object ว่าง)

  res.json({
    success: true,
    message: "NAT Assembly Combine Realtime API is working",
    data: finalStructure,
  });
});
module.exports = router;
