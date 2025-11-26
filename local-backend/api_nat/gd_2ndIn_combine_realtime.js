const express = require("express");
const { queryCurrentRunningTime: currentIn, getMachineData: machineDataIn, prepareRealtimeData: prepareIn } = require("./gd_2ndInBore_realtime");
const router = express.Router();

router.get("/", async (req, res) => {
  const dataIn = prepareIn(machineDataIn(), await currentIn()).filter((item) => item.mc_no.includes("IR"));

  const combinedData = [...dataIn].map((item) => {
    const machineNumber = parseInt(item.mc_no.slice(-2));
    return {
      ...item,
      line: machineNumber,
    };
  });

  const finalStructure = combinedData.reduce((acc, curr) => {
    const line = curr.line;

    if (!acc[line]) {
      acc[line] = [];
    }

    acc[line].push(curr);

    return acc;
  }, {});

  res.json({
    success: true,
    message: "NAT Assembly Combine Realtime API is working",
    data: finalStructure,
  });
});
module.exports = router;
