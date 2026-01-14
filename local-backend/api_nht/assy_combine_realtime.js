const express = require("express");

const { queryCurrentRunningTime: currentMBRF, getMachineData: machineDataMBRF, prepareRealtimeData: prepareMBRF } = require("./assy_mbrf_realtime");
const { queryCurrentRunningTime: currentMBR, getMachineData: machineDataMBR, prepareRealtimeData: prepareMBR } = require("./assy_mbr_realtime");
// const { queryCurrentRunningTime: currentARP, getMachineData: machineDataARP, prepareRealtimeData: prepareARP } = require("./assy_arp_realtime"); // NHT ยังไม่มี
const { queryCurrentRunningTime: currentGSSM, getMachineData: machineDataGSSM, prepareRealtimeData: prepareGSSM } = require("./assy_gssm_realtime");
const { queryCurrentRunningTime: currentFIM, getMachineData: machineDataFIM, prepareRealtimeData: prepareFIM } = require("./assy_fim_realtime");
const { queryCurrentRunningTime: currentANT, getMachineData: machineDataANT, prepareRealtimeData: prepareANT } = require("./assy_ant_realtime");
// const { queryCurrentRunningTime: currentAOD, getMachineData: machineDataAOD, prepareRealtimeData: prepareAOD } = require("./assy_aod_realtime"); // NHT ยังไม่มี
const { queryCurrentRunningTime: currentAVS, getMachineData: machineDataAVS, prepareRealtimeData: prepareAVS } = require("./assy_avs_realtime");
const { queryCurrentRunningTime: currentALU, getMachineData: machineDataALU, prepareRealtimeData: prepareALU } = require("./assy_alu_realtime");
const router = express.Router();

router.get("/", async (req, res) => {
  const dataMBRF = prepareMBRF(machineDataMBRF(), await currentMBRF());
  const dataMBR = prepareMBR(machineDataMBR(), await currentMBR());
  // const dataARP = prepareARP(machineDataARP(), await currentARP());
  const dataGSSM = prepareGSSM(machineDataGSSM(), await currentGSSM());
  const dataFIM = prepareFIM(machineDataFIM(), await currentFIM());
  const dataANT = prepareANT(machineDataANT(), await currentANT());
  // const dataAOD = prepareAOD(machineDataAOD(), await currentAOD());
  const dataAVS = prepareAVS(machineDataAVS(), await currentAVS());
  const dataALU = prepareALU(machineDataALU(), await currentALU());

  // const combinedData = [...dataMBR].map((item) => {
  // // const combinedData = [...dataMBRF, ...dataMBR, ...dataGSSM, ...dataFIM, ...dataANT, ...dataAOD, ...dataAVS, ...dataALU].map((item) => {
  //   const machineNumber = parseInt(item.mc_no.slice(-2));
  //   console.log("machineNumber",item.mc_no,machineNumber);

  //   const lineMaster = machineNumber === 1 ? `${item.process}-FIRST` : `${item.process}-SECOND`;
  //   return {
  //     ...item,
  //     lineMaster,
  //     line: machineNumber,
  //   };
  // });

  const combinedData = [...dataMBR, ...dataMBRF, ...dataALU, ...dataGSSM, ...dataFIM, ...dataAVS, ...dataANT].map((item) => {
    // const combinedData = [...dataMBRF, ...dataMBR, ...dataGSSM, ...dataFIM, ...dataANT, ...dataAOD, ...dataAVS, ...dataALU].map((item) => {
    const type = item.mc_no.includes("MA") ? "MA" : "MD";
    const machineNumber = parseInt(item.mc_no.slice(-2));

    let lineMaster = "";

    if (type === "MA") {
      // เงื่อนไข MA:
      // 1-32 (คี่) หรือ 33-36 (คี่) จริงๆ คือ 1-36 (คี่)
      if (
        machineNumber >= 1 &&
        machineNumber <= 36 &&
        machineNumber % 2 !== 0
      ) {
        lineMaster = `${item.process}-FIRST`;
      } else {
        lineMaster = `${item.process}-SECOND`;
      }
    } else if (type === "MD") {
      // เงื่อนไข MD:
      // 1-22 (คี่) OR 23 (คี่) OR 24-38 (คู่)
      const isOdd1to23 =
        machineNumber >= 1 && machineNumber <= 23 && machineNumber % 2 !== 0;
      const isEven24to38 =
        machineNumber >= 24 && machineNumber <= 38 && machineNumber % 2 === 0;

      if (isOdd1to23 || isEven24to38) {
        lineMaster = `${item.process}-FIRST`;
      } else {
        lineMaster = `${item.process}-SECOND`;
      }
    }
    return {
      ...item,
      lineMaster,
      line: machineNumber,
    };
  });

  //   const finalStructure1 = combinedData.reduce((acc, machine) => {
  // console.log("machine ========");
  // console.log(machine.mc_no);
  // console.log("========machine");
  //     // acc คือ object ที่เรากำลังสร้างขึ้น (accumulator)
  //     // machine คือ object ของเครื่องจักรในแต่ละรอบ

  //     // 1. คำนวณหา key ของกลุ่มหลัก (เช่น "line1&2", "line3&4")
  //     const groupIndex = Math.floor((machine.line - 1) / 2);
  //     const startLine = groupIndex * 2 + 1;
  //     const endLine = groupIndex * 2 + 2;
  //     const groupKey = `${startLine}&${endLine}`;

  //     // 2. ถ้ายังไม่มีกลุ่มนี้ใน object หลัก ให้สร้างขึ้นมาก่อน
  //     if (!acc[groupKey]) {
  //       acc[groupKey] = {};
  //     }

  //     // 3. นำข้อมูลเครื่องจักรไปใส่ในกลุ่มที่ถูกต้อง โดยใช้ lineMaster เป็น key
  //     // และตัว machine object ทั้งหมดเป็น value
  //     acc[groupKey][machine.lineMaster] = machine;

  //     // 4. return acc เพื่อใช้ในรอบถัดไป
  //     return acc;
  //   }, {}); // `{}` คือค่าเริ่มต้นของ accumulator (object ว่าง)

  const finalStructure = combinedData.reduce((acc, machine) => {
    
    
    const type = machine.mc_no.includes("MA") ? "MA" : "MD";
    // console.log("ACC////////"    );
    // console.log(machine.mc_no, type);
    // console.log("////////ACC"    );
    
    // 1. คำนวณ GroupKey (1&2, 3&4, ...)
    const groupIndex = Math.floor((machine.line - 1) / 2);
    const startLine = groupIndex * 2 + 1;
    const endLine = groupIndex * 2 + 2;
    const groupKey = `${startLine}&${endLine}`;

    // 2. สร้างโครงสร้าง Object ชั้นนอกสุด (MA หรือ MD)
    if (!acc[type]) acc[type] = {};

    // 3. สร้างโครงสร้างกลุ่ม Line (1&2) ภายใน Type
    if (!acc[type][groupKey]) acc[type][groupKey] = {};

    // 4. สร้าง Object สำหรับ lineMaster (เช่น XXX-FIRST) ถ้ายังไม่มี
    if (!acc[type][groupKey][machine.lineMaster]) {
      acc[type][groupKey][machine.lineMaster] = {};
    }

    // 5. เก็บข้อมูลเครื่องจักรโดยใช้ mc_no เป็น Key (เพื่อให้ได้โครงสร้าง { "mc_no": {data} })
    acc[type][groupKey][machine.lineMaster] = machine;

    return acc;
  }, {});

  res.json({
    success: true,
    message: "NHT Assembly Combine Realtime API is working",
    // old_data: finalStructure1,
    data: finalStructure,
  });
});

module.exports = router;
