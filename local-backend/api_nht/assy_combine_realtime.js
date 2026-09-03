const express = require("express");
const moment = require("moment");

const { queryCurrentRunningTime: currentMBRF, getMachineData: machineDataMBRF, prepareRealtimeData: prepareMBRF } = require("./assy_mbrf_realtime");
const { queryCurrentRunningTime: currentMBR, getMachineData: machineDataMBR, prepareRealtimeData: prepareMBR } = require("./assy_mbr_realtime");
const { queryCurrentRunningTime: currentGSSM, getMachineData: machineDataGSSM, prepareRealtimeData: prepareGSSM } = require("./assy_gssm_realtime");
const { queryCurrentRunningTime: currentFIM, getMachineData: machineDataFIM, prepareRealtimeData: prepareFIM } = require("./assy_fim_realtime");
const { queryCurrentRunningTime: currentANT, getMachineData: machineDataANT, prepareRealtimeData: prepareANT } = require("./assy_ant_realtime");
const { queryCurrentRunningTime: currentALU, getMachineData: machineDataALU, prepareRealtimeData: prepareALU } = require("./assy_alu_realtime");
const { getLineMaster } = require("./_master_assy_line");
const router = express.Router();

// A live machine absent from `assy_machine` is dropped from the response. That
// is a master-data gap, not a runtime error, so it must not fail the request —
// but it must not vanish silently either. Warn only when the set changes,
// otherwise a permanent gap would log on every 30s poll.
let lastUnmappedKey = "";
const warnUnmapped = (mcNos) => {
  const key = mcNos.sort().join(",");
  if (key === lastUnmappedKey) return;
  lastUnmappedKey = key;
  if (key) console.warn(`[nht/assy/combine-realtime] ${mcNos.length} machine(s) not in assy_machine master:`, key);
};

router.get("/", async (req, res) => {
  // One shared instant so every process computes the same shift window.
  const now = moment();
  const [master, runMBRF, runMBR, runGSSM, runFIM, runANT, runALU] = await Promise.all([
    getLineMaster(),
    currentMBRF(),
    currentMBR(),
    currentGSSM(),
    currentFIM(),
    currentANT(),
    currentALU(),
  ]);

  const dataMBRF = prepareMBRF(machineDataMBRF(), runMBRF, now);
  const dataMBR = prepareMBR(machineDataMBR(), runMBR, now);
  const dataGSSM = prepareGSSM(machineDataGSSM(), runGSSM, now);
  const dataFIM = prepareFIM(machineDataFIM(), runFIM, now);
  const dataANT = prepareANT(machineDataANT(), runANT, now);
  const dataALU = prepareALU(machineDataALU(), runALU, now);

  // The line set comes from master, so the page renders a stable row set even
  // when a whole line stops reporting. Lines with no live machine keep `{}`.
  const byLineId = new Map(master.lines.map((line) => [line.line_id, { ...line, machines: {} }]));

  const unmapped = [];
  for (const item of [...dataMBR, ...dataMBRF, ...dataGSSM, ...dataFIM, ...dataANT, ...dataALU]) {
    const home = master.byMcNo.get(item.mc_no);
    if (!home) {
      unmapped.push(item.mc_no);
      continue;
    }
    // Keyed by the live record's own process, not by master's mg_code: MBR and
    // MBR_F share one mc_no, so only `process` tells the two records apart.
    byLineId.get(home.line_id).machines[item.process] = item;
  }
  warnUnmapped(unmapped);

  res.json({
    success: true,
    message: "NHT Assembly Combine Realtime API is working",
    data: [...byLineId.values()],
  });
});

module.exports = router;
